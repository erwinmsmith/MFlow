import {
  createDitto,
  createContextWorker,
  createInferWorker,
  createInteractionWorker,
  graph,
  runReactFlow,
  createHttpProvider,
  Sandbox,
  TokenBudget,
  BudgetExceededError,
  BranchStore,
  stateDigest,
  type BudgetScope,
  type RegisteredTool,
} from "@codesoul-co/ditto";
import type {
  ModelProvider,
  SampleInput,
  SampleOutput,
} from "@codesoul-co/ditto/worker/infer";
import { z } from "zod";
import { setTimeout as delay } from 'node:timers/promises';
import { modelFetch, observableProvider, ProviderFailure, type TransportOptions } from "./provider-progress.js";
import { AGENT_PROMPT, REVIEW_PROMPT, FACTORY_PROMPT, FORMAT_PROMPT } from "./prompts.js";
import { pythonExecutor } from "./python-tool.js";
import { withTaskImages } from './data.js';
import {
  agentOutputSchema,
  profileSchema,
  type AgentProfile,
  type AgentState,
  type Artifact,
  type Deficit,
  type Limits,
  type TaskInput,
  type Strategy,
} from "./types.js";

export const executionVersion = stateDigest({ code: "mflow-native-library-v3.7/generation-progress", AGENT_PROMPT, REVIEW_PROMPT, FACTORY_PROMPT, FORMAT_PROMPT });

export interface ModelSettings {
  model: string;
  baseUrl: string;
  temperature: number;
  seed: number;
  providerOptions?: Record<string, unknown>;
}
export class BudgetExhausted extends Error {}
export class EpisodeExhausted extends Error {
  constructor(message: string, readonly reason: "episode_budget" | "output_limit" | "reasoning_token_limit" = "episode_budget") { super(message); }
}
/** All actual admission and settlement is owned by published Ditto. Serial episode facade. */
export class MeteredProvider implements ModelProvider {
  private budget = new TokenBudget(Number.MAX_SAFE_INTEGER);
  private episode?: TokenBudget;
  private admitted = 0;
  private scope: BudgetScope = { runId: "search" };
  denial?: "search" | "episode";
  lastFinishReason?: SampleOutput["finishReason"];
  lastFailure?: ProviderFailure;
  readonly nodeFailures = new Map<string, ProviderFailure>();
  replayTokens = 0;
  replayCalls = 0;
  constructor(
    private readonly inner: ModelProvider,
    readonly estimate = (input: SampleInput) =>
      Buffer.byteLength(JSON.stringify(input), "utf8") +
      (input.generation?.maxTokens ?? 1200) +
      1024,
    readonly observe?: (records: MeteredProvider["records"]) => Promise<void>,
  ) {}
  get records() {
    return this.budget.records;
  }
  get calls() {
    return this.admitted;
  }
  get tokens() {
    return this.budget.spent;
  }
  get logicalTokens() {
    return this.tokens + this.replayTokens;
  }
  get logicalCalls() {
    return this.calls + this.replayCalls;
  }
  get tokenLimit() {
    return this.budget.limit;
  }
  set tokenLimit(limit: number) {
    if (this.tokens || this.calls)
      throw new Error("Set search budget before first model call");
    this.budget = new TokenBudget(limit);
  }
  beginEpisode(limit: number, scope: BudgetScope) {
    this.episode = new TokenBudget(Math.max(1, limit));
    this.scope = scope;
    this.denial = undefined;
    this.lastFinishReason = undefined;
    this.lastFailure = undefined;
    this.nodeFailures.clear();
  }
  endEpisode() {
    this.episode = undefined;
    this.scope = { runId: "search" };
  }
  replay(tokens: number, calls: number) {
    if (tokens > 0 && this.episode) {
      if (tokens > this.episode.remaining)
        throw new EpisodeExhausted(
          "Cached turn exceeds logical episode budget",
        );
      this.episode.reserve(tokens, { ...this.scope, label: "replay" })({
        totalTokens: tokens,
      });
    }
    this.replayTokens += tokens;
    this.replayCalls += calls;
  }
  async invoke(
    input: SampleInput,
    options: { signal: AbortSignal },
    attempt = 0,
  ): Promise<SampleOutput> {
    options.signal.throwIfAborted();
    const nodeId = String(input.metadata?.nodeId ?? '');
    this.nodeFailures.delete(nodeId);
    this.denial = undefined;
    this.lastFinishReason = undefined;
    const reservation = this.estimate(input);
    if (reservation > this.budget.remaining) {
      this.denial = "search";
      throw new BudgetExhausted("Search reservation denied");
    }
    if (this.episode && reservation > this.episode.remaining) {
      this.denial = "episode";
      throw new EpisodeExhausted("Episode reservation denied");
    }
    const scope = {
      ...this.scope,
      label: String(input.metadata?.kind ?? "inference"),
    };
    const settlements = [this.budget.reserve(reservation, scope)];
    if (this.episode)
      settlements.push(this.episode.reserve(reservation, scope));
    this.admitted++;
    await this.observe?.(this.records);
    let result: SampleOutput;
    try {
      result = await this.inner.invoke(input, options);
      this.lastFinishReason = result.finishReason;
    } catch (error) {
      for (const settle of settlements) settle();
      await this.observe?.(this.records);
      const failure = error instanceof ProviderFailure ? error : new ProviderFailure(
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'PROVIDER_FAILURE',
        error instanceof Error ? error.message : String(error), error);
      this.nodeFailures.set(nodeId, failure);
      const cause = failure.cause as { code?: string; cause?: { code?: string } } | undefined;
      const transient = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'PROVIDER_IDLE_TIMEOUT'].includes(
        String(cause?.code ?? cause?.cause?.code ?? failure.code)) ||
        (failure.code === 'PROVIDER_FAILURE' && /^(?:\[PROVIDER_FAILURE\] )?terminated$/.test(failure.message));
      if (transient && attempt < 2 && !options.signal.aborted) {
        // Each attempt reserves/settles separately. No partial text is reused,
        // and missing usage remains unknown rather than disappearing on retry.
        await delay(1000 * (attempt + 1), undefined, { signal: options.signal });
        return this.invoke(input, options, attempt + 1);
      }
      // A detected generation cycle belongs to this node. Network/auth/service
      // failures remain episode-fatal, including when sibling nodes succeed.
      if (!['DEGENERATE_OUTPUT', 'INVALID_MODEL_OUTPUT', 'INCOMPLETE_MODEL_OUTPUT', 'MODEL_CONTEXT_LIMIT'].includes(failure.code)) this.lastFailure = failure;
      throw failure;
    }
    let failure: unknown;
    for (const settle of settlements) {
      try {
        settle(result.usage);
      } catch (error) {
        failure = error;
      }
    }
    await this.observe?.(this.records);
    if (failure instanceof BudgetExceededError)
      throw new Error(
        "Provider exceeded token estimate; stop and correct provider bound",
        { cause: failure },
      );
    if (failure) throw failure;
    const u = result.usage;
    const total =
      u?.totalTokens ??
      (u?.inputTokens !== undefined && u.outputTokens !== undefined
        ? u.inputTokens + u.outputTokens
        : undefined);
    if (total === undefined || !Number.isSafeInteger(total) || total < 0)
      throw new Error(
        "Provider token usage unavailable; reserved amount charged",
      );
    return result;
  }
}
export function httpProvider(
  settings: ModelSettings,
  key: string,
  transport: TransportOptions = {},
): ModelProvider {
  if (!key) throw new Error("MFLOW_API_KEY is required");
  const deepseek = new URL(settings.baseUrl).hostname === "api.deepseek.com";
  const provider = createHttpProvider({
    kind: "openai-compatible",
    baseUrl: settings.baseUrl,
    apiKey: key,
    // The per-call Limits deadline below owns cancellation. Avoid a hidden 30s HTTP cutoff.
    timeoutMs: 2147483647,
    ...(process.env.MFLOW_PROVIDER_IDLE_TIMEOUT_MS ? { idleTimeoutMs: Number(process.env.MFLOW_PROVIDER_IDLE_TIMEOUT_MS) } : {}),
    fetch: modelFetch,
    ...(deepseek ? {
      maxTokensField: "max_tokens" as const,
      providerOptions: { thinking: { type: "disabled" }, response_format: { type: "json_object" } },
    } : {}),
    ...(settings.providerOptions ? { providerOptions: settings.providerOptions } : {}),
    sandbox: new Sandbox(process.cwd(), {
      network: [new URL(settings.baseUrl).origin],
    }),
  });
  return observableProvider(provider, { stream: true, ...transport });
}

export const arithmeticTool: RegisteredTool = {
  name: "arithmetic",
  description: "Compute a finite arithmetic operation over numbers.",
  effects: ["read"],
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["add", "subtract", "multiply", "divide"],
      },
      values: { type: "array", items: { type: "number" }, minItems: 2 },
    },
    required: ["operation", "values"],
    additionalProperties: false,
  },
  validate(args) {
    arithmeticArgs.parse(args);
  },
  async execute(args) {
    const { operation, values } = arithmeticArgs.parse(args);
    const value = values
      .slice(1)
      .reduce(
        (a, b) =>
          operation === "add"
            ? a + b
            : operation === "subtract"
              ? a - b
              : operation === "multiply"
                ? a * b
                : a / b,
        values[0],
      );
    if (!Number.isFinite(value))
      return {
        status: "failed",
        error: {
          code: "NONFINITE",
          message: "Arithmetic result is not finite",
        },
      };
    return {
      status: "success",
      content: String(value),
      structuredContent: { value },
    };
  },
};
const arithmeticArgs = z
  .object({
    operation: z.enum(["add", "subtract", "multiply", "divide"]),
    values: z.array(z.number().finite()).min(2),
  })
  .strict();

/** All model calls, reasoning and actions go through registry Ditto Workers/Graphs. */
export class DittoAgents {
  constructor(
    readonly provider: MeteredProvider,
    readonly model: ModelSettings,
    readonly tools: RegisteredTool[] = [arithmeticTool],
  ) {}
  cacheEnabled = false;
  prompts?: Strategy["prompts"];
  private cache = new BranchStore("agent-cache");
  private cacheKeys: string[] = [];
  assertReplaySafe() {
    if (this.tools.some((tool) => tool !== arithmeticTool))
      throw new Error(
        "Checkpoint/cache requires isolated versioned resources; only the built-in pure arithmetic tool is supported",
      );
  }
  get resourceVersion() {
    return executionVersion;
  }
  runtime(tools: string[], timeoutMs: number) {
    const chosen = this.tools.filter((t) => tools.includes(t.name));
    if (chosen.length !== new Set(tools).size)
      throw new Error("Agent requested an unregistered tool");
    return createDitto({
      ...(chosen.some((t) => t.name === 'python') ? { sandboxExecutor: pythonExecutor() } : {}),
      workers: [
        // Largest values accepted by the published ContextPolicy validator.
        // The package has no unbounded setting; tracked as DITTO-006.
        createContextWorker({ policy: { maxInlineBytes: 1_000_000, maxItems: 1_000_000 } }),
        createInferWorker({
          providers: { mflow: this.provider },
          defaultProvider: "mflow",
          timeoutMs,
        }),
        createInteractionWorker({ tools: chosen }),
      ],
      sandbox: {
        execute: chosen.some((t) => t.name === 'python'),
        tools: chosen.map((t) => t.name),
        network: [new URL(this.model.baseUrl).origin, ...(chosen.some(t=>t.name==='web_search')?['https://www.bing.com']:[])],
      },
    });
  }
  async structured<T>(
    kind: string,
    instruction: string,
    payload: unknown,
    schema: z.ZodType<T>,
    limits: Limits,
    profile?: AgentProfile,
    repair = true,
  ): Promise<{ value: T; toolEvents: unknown[] }> {
    const decode = async (content: unknown): Promise<T> => {
      try { return parseJSON(content, schema); }
      catch (error) {
        if (!repair) throw error;
        return (await this.structured(`${kind}-format-repair`, FORMAT_PROMPT, { output: content }, schema, limits, undefined, false)).value;
      }
    };
    const runtime = this.runtime(profile?.tools ?? [], limits.timeoutMs);
    const imageTask=(payload as {task?:TaskInput})?.task;
    if(imageTask?.imageParts?.length)payload={...(payload as object),task:{id:imageTask.id,prompt:imageTask.prompt}};
    const messages = withTaskImages([
      {
        role: "system" as const,
        content:
          instruction +
          "\nReturn one JSON object only, matching this schema:\n" +
          JSON.stringify(z.toJSONSchema(schema)),
      },
      { role: "user" as const, content: JSON.stringify({ kind, payload }) },
    ],imageTask);
    const model = { provider: "mflow", model: this.model.model };
    const generation = {
      temperature: this.model.temperature,
      ...(new URL(this.model.baseUrl).hostname === "api.deepseek.com"
        ? {} : { seed: this.model.seed }),
      maxTokens: limits.maxOutputTokens,
    };
    const signal = AbortSignal.timeout(limits.timeoutMs);
    try {
      if (profile?.reasoning === "react" || profile?.tools.length) {
        const result = await runReactFlow(
          runtime,
          {
            messages,
            model,
            generation,
            actions: this.tools
              .filter((t) => profile.tools.includes(t.name))
              .map((t) => ({
                name: t.name,
                description: t.description,
                inputSchema: t.inputSchema,
                target: { kind: "tool" as const, toolName: t.name },
              })),
            metadata: { kind },
            constraints: {
              maxSteps: this.prompts ? limits.maxSteps : 4,
              maxActionCalls: limits.maxToolCalls,
              maxTotalTokens: limits.maxTokens,
              timeoutMs: limits.timeoutMs,
            },
          },
          { signal, timeoutMs: limits.timeoutMs },
        );
        if (result.stopReason === "max_tokens")
          throw new EpisodeExhausted("Model output or reasoning token limit reached",
            this.provider.lastFinishReason === "length" ? "output_limit" : "reasoning_token_limit");
        if (result.status !== "completed")
          throw new Error(
            `Ditto agent failed: ${result.stopReason} ${result.error?.message ?? ""}`,
          );
        return {
          value: await decode(result.result.content),
          toolEvents: result.observations,
        };
      }
      const plan = graph<typeof messages>(`mflow-${kind}`)
        .node(
          "reason",
          "INFER.REASONING.TRAJECTORY",
          [],
          (input) => ({
            // These are already complete messages, including full optimizer
            // history. A Context inline item adds no data transformation here.
            messages: input,
            model,
            generation,
            strategy: {
              name: profile?.reasoning ?? "cot",
              options: { rounds: 1 },
            },
            constraints: {
              maxSteps: 2,
              maxTotalTokens: limits.maxTokens,
              timeoutMs: limits.timeoutMs,
            },
            metadata: { kind },
          }),
        );
      const result = await runtime.run(plan, messages, { signal });
      if (result.reason.output?.stopReason === "max_tokens")
        throw new EpisodeExhausted("Model output or reasoning token limit reached",
          this.provider.lastFinishReason === "length" ? "output_limit" : "reasoning_token_limit");
      if (
        result.reason.status !== "success" ||
        result.reason.output?.status !== "completed"
      )
        throw new Error(
          `Ditto inference failed: ${result.reason.error?.message ?? result.reason.output?.stopReason ?? "no result"}`,
        );
      return {
        value: await decode(result.reason.output.result.content),
        toolEvents: [],
      };
    } catch (error) {
      if (this.provider.lastFailure) throw this.provider.lastFailure;
      if (this.provider.denial === "search")
        throw new BudgetExhausted("Search reservation denied");
      if (this.provider.denial === "episode")
        throw new EpisodeExhausted("Episode reservation denied");
      throw error;
    } finally {
      await runtime.close();
    }
  }
  async execute(
    agent: AgentState,
    task: TaskInput,
    deficits: Deficit[],
    incoming: Artifact[],
    limits: Limits,
    review = false,
  ) {
    if (this.cacheEnabled) this.assertReplaySafe();
    const key = this.cacheEnabled
      ? stateDigest({
          version: this.resourceVersion,
          model: this.model,
          agent,
          task,
          deficits,
          incoming,
          limits,
          review,
          prompts: this.prompts,
        })
      : "";
    type Cached = {
      value: z.infer<typeof agentOutputSchema>;
      toolEvents: unknown[];
      tokens: number;
      calls: number;
    };
    const branch = this.cacheEnabled ? this.cache.fork() : undefined;
    const hit = branch?.get<Cached>(key);
    if (hit) {
      branch!.discard();
      this.provider.replay(hit.tokens, hit.calls);
      return { value: hit.value, toolEvents: hit.toolEvents };
    }
    const before = this.provider.tokens,
      beforeCalls = this.provider.calls;
    let result;
    try {
      result = await this.structured(
        review ? "review" : "agent",
        review ? (this.prompts?.review ?? REVIEW_PROMPT) :
          incoming.length ? (this.prompts?.integrate ?? this.prompts?.agent ?? AGENT_PROMPT) :
            (this.prompts?.agent ?? AGENT_PROMPT),
        {
          task,
          profile: agent.profile,
          episode: agent.episode,
          assigned: deficits.find((d) => d.id === agent.assigned),
          owned_deficits: deficits.filter((d) => d.owner === agent.profile.id),
          incoming,
        },
        agentOutputSchema,
        limits,
        agent.profile,
      );
      if (branch) {
        branch.set(key, {
          ...result,
          tokens: this.provider.tokens - before,
          calls: this.provider.calls - beforeCalls,
        });
        const evicted =
          this.cacheKeys.length >= 256 ? this.cacheKeys[0] : undefined;
        if (evicted) branch.delete(evicted);
        branch.commit();
        if (evicted) this.cacheKeys.shift();
        this.cacheKeys.push(key);
      }
      return result;
    } catch (error) {
      branch?.discard();
      throw error;
    }
  }
  validateProfile(profile: AgentProfile) {
    profileSchema.parse(profile);
    if (profile.tools.some(name => !this.tools.some(tool => tool.name === name)))
      throw new Error("Agent requested an unavailable tool");
  }
  async derive(
    deficit: Deficit,
    parent: AgentProfile,
    task: TaskInput,
    id: string,
    limits: Limits,
    parentOutput?: z.infer<typeof agentOutputSchema>,
  ): Promise<AgentProfile> {
    const result = await this.structured(
      "factory",
      this.prompts?.factory ?? FACTORY_PROMPT,
      {
        id,
        deficit,
        parent,
        parent_evidence: parentOutput,
        task,
        available_tools: this.tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
      profileSchema,
      limits,
    );
    if (result.value.id !== id)
      throw new Error("Factory changed assigned agent ID");
    this.validateProfile(result.value);
    return result.value;
  }
  async retrieve(
    deficit: Deficit,
    profiles: AgentProfile[],
    limits: Limits,
  ): Promise<string | undefined> {
    if (!profiles.length) return undefined;
    const result = await this.structured(
      "retrieve",
      this.prompts?.retrieve ?? "Classify whether an existing capability is relevant to the deficit. Return the ID of one relevant agent, or null. This is a categorical relevance decision, not a utility or confidence score.",
      {
        deficit,
        candidates: profiles.map(({ id, capability, objective, tools }) => ({
          id,
          capability,
          objective,
          tools,
        })),
      },
      z.object({ agent_id: z.string().nullable() }).strict(),
      limits,
    );
    const id = result.value.agent_id;
    if (id && !profiles.some((p) => p.id === id))
      throw new Error("Retriever selected an unknown agent");
    return id ?? undefined;
  }
}
function parseJSON<T>(content: unknown, schema: z.ZodType<T>): T {
  if (typeof content !== "string")
    throw new Error("Expected a textual JSON agent result");
  const clean = content
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  return schema.parse(JSON.parse(clean));
}
