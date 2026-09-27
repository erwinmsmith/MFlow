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
import { AGENT_PROMPT, REVIEW_PROMPT, FACTORY_PROMPT, FORMAT_PROMPT } from "./prompts.js";
import {
  agentOutputSchema,
  profileSchema,
  type AgentProfile,
  type AgentState,
  type Artifact,
  type Deficit,
  type Limits,
  type TaskInput,
} from "./types.js";

export const executionVersion = stateDigest({ code: "mflow-explicit-state-v3/arithmetic-v1", AGENT_PROMPT, REVIEW_PROMPT, FACTORY_PROMPT, FORMAT_PROMPT });

export interface ModelSettings {
  model: string;
  baseUrl: string;
  temperature: number;
  seed: number;
}
export class BudgetExhausted extends Error {}
export class EpisodeExhausted extends Error {}
/** All actual admission and settlement is owned by published Ditto. Serial episode facade. */
export class MeteredProvider implements ModelProvider {
  private budget = new TokenBudget(Number.MAX_SAFE_INTEGER);
  private episode?: TokenBudget;
  private admitted = 0;
  private scope: BudgetScope = { runId: "search" };
  denial?: "search" | "episode";
  replayTokens = 0;
  replayCalls = 0;
  constructor(
    private readonly inner: ModelProvider,
    readonly estimate = (input: SampleInput) =>
      Buffer.byteLength(JSON.stringify(input), "utf8") +
      (input.generation?.maxTokens ?? 1200) +
      1024,
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
  ): Promise<SampleOutput> {
    options.signal.throwIfAborted();
    this.denial = undefined;
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
    let result: SampleOutput;
    try {
      result = await this.inner.invoke(input, options);
    } catch (error) {
      for (const settle of settlements) settle();
      throw error;
    }
    let failure: unknown;
    for (const settle of settlements) {
      try {
        settle(result.usage);
      } catch (error) {
        failure = error;
      }
    }
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
): ModelProvider {
  if (!key) throw new Error("MFLOW_API_KEY is required");
  const deepseek = new URL(settings.baseUrl).hostname === "api.deepseek.com";
  return createHttpProvider({
    kind: "openai-compatible",
    baseUrl: settings.baseUrl,
    apiKey: key,
    ...(deepseek ? {
      maxTokensField: "max_tokens" as const,
      providerOptions: { thinking: { type: "disabled" }, response_format: { type: "json_object" } },
    } : {}),
    sandbox: new Sandbox(process.cwd(), {
      network: [new URL(settings.baseUrl).origin],
    }),
  });
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
  private runtime(tools: string[], timeoutMs: number) {
    const chosen = this.tools.filter((t) => tools.includes(t.name));
    if (chosen.length !== new Set(tools).size)
      throw new Error("Agent requested an unregistered tool");
    return createDitto({
      workers: [
        createContextWorker(),
        createInferWorker({
          providers: { mflow: this.provider },
          defaultProvider: "mflow",
          timeoutMs,
        }),
        createInteractionWorker({ tools: chosen }),
      ],
      sandbox: {
        tools: chosen.map((t) => t.name),
        network: [new URL(this.model.baseUrl).origin],
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
    const messages = [
      {
        role: "system" as const,
        content:
          instruction +
          "\nReturn one JSON object only, matching this schema:\n" +
          JSON.stringify(z.toJSONSchema(schema)),
      },
      { role: "user" as const, content: JSON.stringify({ kind, payload }) },
    ];
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
              maxSteps: 4,
              maxActionCalls: limits.maxToolCalls,
              maxTotalTokens: limits.maxTokens,
              timeoutMs: limits.timeoutMs,
            },
          },
          { signal, timeoutMs: limits.timeoutMs },
        );
        if (result.stopReason === "max_tokens")
          throw new EpisodeExhausted("Model output or episode token limit reached");
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
        .node("context", "CONTEXT.LOAD", [], (input) => ({ sources: input }))
        .node(
          "reason",
          "INFER.REASONING.TRAJECTORY",
          ["context"],
          (_input, { context }) => ({
            messages: context.items.map((item, i) => ({
              role: messages[i]?.role ?? "user",
              content: typeof item.content === "string" ? item.content : JSON.stringify(item.content) ?? "",
            })),
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
        throw new EpisodeExhausted("Model output or episode token limit reached");
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
        review ? REVIEW_PROMPT : AGENT_PROMPT,
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
      FACTORY_PROMPT,
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
    if (result.value.tools.some((t) => !this.tools.some((x) => x.name === t)))
      throw new Error("Factory requested an unavailable tool");
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
      "Classify whether an existing capability is relevant to the deficit. Return the ID of one relevant agent, or null. This is a categorical relevance decision, not a utility or confidence score.",
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
