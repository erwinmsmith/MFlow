import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from 'node:util';
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DittoAgents, MeteredProvider, httpProvider, executionVersion, arithmeticTool, type ModelSettings } from "./ditto.js";
import { pythonImage, createPythonTool } from './python-tool.js';
import { OrganizationRuntime } from "./runtime.js";
import { strategySchema, organizationSchema, rootProfile, searchConfigSchema, type Task, type Strategy, type AgentProfile } from "./types.js";
import { AGENT_PROMPT, FACTORY_PROMPT, REVIEW_PROMPT } from "./prompts.js";
import { readTasks, assertDatasetRole, promptKey } from "./data.js";
import { checkScoring, grade } from "./grading.js";
import { append, save, digest, mean } from "./util.js";
import { PolicyContractError } from "./strategy-program.js";
import { organizationEvidence, summarizeOrganizations } from "./organization.js";
import { initialComposition, validateComposition } from "./composition.js";
import { ProviderFailure } from "./provider-progress.js";
import type { Bundle } from "./search.js";

export const aflowConfigSchema = z.object({
  seed: z.number().int().default(42), maxRounds: z.number().int().positive().nullable().default(null),
  validationRounds: z.number().int().positive().default(5),
  concurrency: z.number().int().positive().default(50),
  maxOutputTokens: z.number().int().positive().default(393216),
}).strict();

export const initialOrganization: { initialAgents: AgentProfile[] } = { initialAgents: [{ ...rootProfile,
  tools: ["arithmetic", "python"], reasoning: "react" as const,
  nodes: ["CONTEXT.LOAD", "INFER.REASONING.SAMPLE", "INTERACTION.ACT.TOOL", "INTERACTION.OBSERVE"],
}] };
export const programPrompts = {
  agent: AGENT_PROMPT, factory: FACTORY_PROMPT, review: REVIEW_PROMPT,
  integrate: AGENT_PROMPT,
  retrieve: 'Select one existing agent whose capability is relevant to the deficit; return agent_id or null. No confidence scores.',
};
const proposalSchema = z.object({
  modification: z.string().min(1), composition: z.string().min(1),
  prompts: strategySchema.shape.prompts.unwrap(),
  organization: organizationSchema,
}).strict();

export const policyInterface = `SEARCH OBJECT: a complete dynamic MAS built with the published Ditto graph(), loop(), graphStep() APIs. Return composition (JavaScript source), organization.initialAgents and all five prompts. composition executes once per task and RETURNS loop({id, plan: function* (ctx) {...}}). The generator must yield* graphStep(nativeGraph, input) and return the final answer STRING. Nested generators and yield* allow different agent loops to be serial, interleaved, recursive, or combined into one DAG. Do not reduce this to an outer action selector or a fixed shared agent implementation.
Every profile has id, objective, capability, private_context, tools, nodes, reasoning, expected_output, stop_condition. nodes is the agent's permitted Ditto leaf capabilities; different agents SHOULD have different internal graph topology, node types, bindings, inference strategies and loop conditions when justified by feedback. Graph builders/functions in composition define those structures explicitly, rather than a universal template selected only by role prompts. Each node ID is agentId/localName. Cross-agent dependencies are allowed within one graph. Agent IDs are unique, cannot contain '/', and root must exist. tools must be drawn from arithmetic and python. reasoning is a profile description (cot/long-cot/react/tot/got/self-consistency); the actual searched nodes and bindings determine inference.
Public bindings: graph(id).node(id, nodeType, dependencyIds, (input, outputs) => nodeInput); graphStep(graph, input, {concurrency?}); loop({id, plan: function*(ctx){...}}). Dependencies must refer to already added nodes. Independent nodes can run concurrently under Ditto. Loop generators may inspect every completed graph, spawn/reconfigure profiles, build new graphs and route outputs before yielding the next graph. This supports dynamic topology, internal agent loops and node-level cross-agent weaving. No fixed population, derivation depth, sampling count or experiment token budget.
ctx.task is {id,prompt}, without reference answers. ctx.agents returns [{profile,status,depth}] where status is exactly ACTIVE or DORMANT. ctx.profile(id) returns a profile. ctx.spawn(completeProfile,parentId='root') adds a task-local profile and returns it; this does not call a model. A factory can first yield a Ditto inference graph to generate a profile. ctx.reconfigure(id,completeProfile) changes future capabilities while preserving identity. ctx.dormant(id) releases activity. Executing a graph node activates its owning agent. Each task starts with fresh profiles; no episode memory enters the next task.
ctx.messages(id,evidence=[],prompt='agent') builds JSON-output messages from the profile, original task and explicitly routed evidence. prompt selects agent/factory/review/integrate/retrieve. ctx.request(id,messages,useTools=true) creates a SAMPLE input using the experiment model, generation settings and allowed action descriptors. ctx.formatMessages(content) requests syntax-only JSON repair. ctx.unwrap(nodeResult) checks success and returns output. ctx.decode(content) parses the fixed AgentOutput schema; ctx.publish(id,output) records and returns it. ctx.outputs contains published outputs; ctx.graphs contains completed graph topology/results. These helpers do not execute models, tools or choose a workflow. Explicitly pass prior outputs as evidence to downstream nodes/agents. A dynamic plan may use its own local state, functions, conditions and generators.
Configured native nodes (declare only needed capabilities on each profile):
CONTEXT.LOAD: {sources: Message[]} -> {items}; CONTEXT.SELECT: {context,purpose:'infer'|'memory',query?,limit?,maxTokens?,strategy?:{kind:'default'}} -> {context,selectedItemIds}; CONTEXT.UPDATE: {context,add?:ContextItem[],removeIds?:string[]} -> Context; CONTEXT.COMPRESS: {context,maxTokens?,maxItems?} -> Context.
INFER.REASONING.SAMPLE: {messages,model,generation?,actions?,metadata?} -> NodeResult {status,output:{message,actionRequests?,finishReason,usage}}.
INFER.REASONING.TRAJECTORY: {messages,strategy:{name:'cot'|'long-cot'|'tot'|'got'|'self-consistency',options?},model,generation?,constraints?} -> NodeResult {output:{result,steps,status,stopReason,usage}}. cot/long-cot options:{rounds}; tot options:{breadth,depth,beamWidth}; got options:{breadth,depth}; self-consistency options:{candidates}. react tool execution requires explicit SAMPLE -> INTERACTION nodes -> observation-fed SAMPLE graphs; a trajectory alone does not run tools.
INFER.REASONING.REFLECT: {target:{result?:Message,trajectory?:ReasoningStep[],artifact?:unknown},mode:'critique'|'verify'|'revise',messages?,criteria?,model,generation?} -> NodeResult {output:{assessment,issues,revisedResult?,usage}}.
INFER.REASONING.DELIBERATE: {candidates:[{id,result:Message}],mode:'select'|'merge'|'consensus'|'debate',objective?,messages?,model,generation?} -> NodeResult {output:{result,selectedCandidateIds?,decisionSummary?,usage}}.
INTERACTION.ACT.TOOL: {call:{id,name,arguments}} -> ExternalResult; INTERACTION.OBSERVE: {result:ExternalResult} -> {message,callId,status,...}. Tool messages fed back to inference require metadata:{actionRequestId:call.id,name:call.name}; assistant messages carrying requests require metadata:{actionRequests}. Tools execute through Ditto with profile permissions and isolated Python, never eval/process/network from composition. Dynamic executable tool registration is not exposed as a searched node in this version; do not invent a CREATE_TOOL contract.
All model/provider settings and resource permissions remain fixed by the experiment; they are not optimization variables. No imports, filesystem, process, network, clocks or direct provider calls in composition. VM guards are control-flow guards, not an OS security boundary. Entire graphs, agent-specific loops, profiles, bindings and dynamic derivation decisions are inherited as the parent artifact, along with measured node/lifecycle/graph feedback. Preserve useful structures. Make one focused modification using the original AFlow feedback/experience method; return complete artifacts, not patches. No benchmark answers or task-specific solution tables in code/prompts/profiles. No test data is available to search. Static graph structure may be part of the reusable program, but the dynamic plan controls when and how to extend it.`;

export async function parallelMap<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false, failure: unknown;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      if (failed) return;
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await fn(items[index], index); }
      catch (error) { failed = true; failure = error; return; }
    }
  }));
  if (failed) throw failure;
  return results;
}

export function unrestrictedConfig(maxOutputTokens: number) {
  const unlimited = Number.MAX_SAFE_INTEGER;
  return searchConfigSchema.parse({ prefixCache: false, agentCache: false,
    maxSearchTokens: unlimited, maxExecutions: unlimited, meanTokenLimit: unlimited,
    meanActiveAgentLimit: unlimited,
    episode: { maxSteps: unlimited, maxActiveAgents: unlimited, maxPoolAgents: unlimited,
      maxDepth: unlimited, maxTokens: unlimited, maxToolCalls: unlimited,
      maxOutputTokens, timeoutMs: 2147483647 } });
}

export async function runAFlowSearch(options: {
  out: string; search: string; source: string; python: string;
  config?: unknown; resume?: boolean; model: ModelSettings;
}) {
  const config = aflowConfigSchema.parse(options.config ?? {}), out = resolve(options.out);
  const tasks = await readTasks(options.search);
  assertDatasetRole(tasks, 'search');
  await checkScoring(tasks);
  const runtimeConfig = unrestrictedConfig(config.maxOutputTokens);
  const image = await pythonImage();
  const makeAgents = (observe?: (records: MeteredProvider['records']) => Promise<void>, context: Record<string, unknown> = {}) =>
    new DittoAgents(new MeteredProvider(httpProvider(options.model, process.env.MFLOW_API_KEY ?? '', {
      onProgress: progress => save(join(out, 'requests', `${progress.id}.json`), { ...context, ...progress }),
    }), undefined, observe), options.model, [arithmeticTool, createPythonTool(image)]);
  // Check configuration before starting the Python optimizer or creating paid requests.
  makeAgents();
  const source = resolve(options.source);
  const lock = JSON.parse(await readFile('baselines/sources.lock.json', 'utf8')).AFlow;
  for (const [name, hash] of Object.entries(lock.files)) {
    const actual = createHash('sha256').update(await readFile(join(source, name))).digest('hex');
    if (actual !== hash) throw new Error(`Official AFlow source changed: ${name}`);
  }
  const codeDir = fileURLToPath(new URL('.', import.meta.url));
  const controller = process.env.MFLOW_AFLOW_CONTROLLER ?? 'scripts/aflow_strategy.py';
  const pythonEnvironment = async (python: string) => (await promisify(execFile)(python, ['-c',
    "import sys,json,importlib.metadata as m; print(json.dumps([sys.version,sorted((p.metadata['Name'],p.version) for p in m.distributions())]))"])).stdout.trim();
  const code: Record<string, string> = {};
  for (const name of await readdir(codeDir))
    if (name.endsWith('.js')) code[name] = digest(await readFile(join(codeDir, name), 'utf8'));
  const manifest = { protocol: 'official-aflow-ditto-composition-v1', transport: 'ditto-public-stream-v1', config, model: options.model,
    dataHash: digest(tasks), source: lock, code, pythonImage: image,
    controller: digest(await readFile(controller, 'utf8')),
    pythonEnvironment: await pythonEnvironment(options.python),
    graderEnvironment: tasks.some((t) => t.metric === 'math') ? await pythonEnvironment(process.env.MFLOW_BENCH_PYTHON ?? 'python3') : undefined,
    grader: digest(await readFile('scripts/grade_math.py', 'utf8')),
    dependencies: digest(await readFile('package-lock.json', 'utf8')) };
  if (options.resume) {
    if (digest(JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'))) !== digest(manifest))
      throw new Error('AFlow search resume manifest mismatch');
  } else {
    await mkdir(out, { recursive: false });
    await save(join(out, 'manifest.json'), manifest);
  }
  const candidate = (value: unknown): Strategy => {
    const parsed = strategySchema.parse({ rules: [{ id: 'unused', status: 'NONE', guards: [], action: 'STOP' }], fallback: 'STOP', ...(value as object) });
    if (!parsed.composition || !parsed.prompts) throw new Error('Complete Ditto composition and prompts required');
    if (!parsed.organization) throw new Error('Complete organization required');
    validateComposition(parsed.composition);
    for (const profile of parsed.organization.initialAgents)
      if (!profile.nodes?.length || profile.id.includes('/')) throw new Error('Every native agent requires node capabilities and an ID without /');
    for (const profile of parsed.organization.initialAgents)
      if (profile.tools.some(t => !['arithmetic', 'python'].includes(t))) throw new Error('Unknown organization tool');
    return parsed;
  };
  type Row = { taskId: string; score: number; answer: string; tokens: number; error?: string; organization?: ReturnType<typeof organizationEvidence> };
  async function evaluation(number: number, repeat: number, strategy: Strategy) {
    const dir = join(out, `round-${number}`, `pass-${repeat}`);
    await mkdir(dir, { recursive: true });
    const identity = { strategyHash: digest(strategy), dataHash: digest(tasks), repeat };
    const existing = await readFile(join(dir, 'manifest.json'), 'utf8').catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return '';
    });
    if (existing && digest(JSON.parse(existing)) !== digest(identity)) throw new Error('Candidate resume mismatch');
    await save(join(dir, 'manifest.json'), identity);
    const rows = await parallelMap(tasks, config.concurrency, async (task: Task, index) => {
      const path = join(dir, `${index}.json`);
      try {
        const saved = JSON.parse(await readFile(path, 'utf8')) as Row;
        if (saved.taskId !== task.id) throw new Error('Task checkpoint mismatch');
        return saved;
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const usagePath = join(dir, `${index}.usage.json`);
      const previousUsage: MeteredProvider['records'] = JSON.parse(await readFile(usagePath, 'utf8').catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return '[]';
      }));
      const agents = makeAgents(async (records) => save(usagePath, [...previousUsage, ...records]), { round: number, repeat, taskId: task.id, index });
      let row: Row = { taskId: task.id, score: 0, answer: '', tokens: 0 };
      // Official MATHBenchmark._generate_output: five attempts, fixed one-second wait.
      for (let attempt = 0; attempt < 5; attempt++) {
        await append(join(dir, `${index}.attempts.jsonl`), { event: 'started', attempt, at: new Date().toISOString() });
        try {
          const execution = await new OrganizationRuntime(agents, runtimeConfig.episode).run(strategy, { id: task.id, prompt: task.prompt });
          row = { taskId: task.id, ...await grade(task, execution.answer), answer: execution.answer, tokens: agents.provider.tokens, organization: organizationEvidence(execution) };
          await save(join(dir, `${index}.execution.json`), execution);
          break;
        } catch (error) {
          // A deterministic application/strategy contract failure is not a model
          // quality observation and cannot be repaired by five paid reruns.
          await append(join(dir, `${index}.attempts.jsonl`), { event: 'failed', attempt, error: String(error), at: new Date().toISOString() });
          if (error instanceof PolicyContractError || error instanceof ProviderFailure || /HTTP \d{3}|Provider returned invalid JSON/.test(String(error))) throw error;
          row.error = String(error);
          if (attempt < 4) await delay(1000);
        } finally {
          await save(usagePath, [...previousUsage, ...agents.provider.records]);
        }
      }
      row.tokens = agents.provider.tokens + previousUsage.reduce((n, r) => n + r.charged, 0);
      await save(path, row);
      console.log(JSON.stringify({ round: number, repeat, task: index + 1, score: row.score, tokens: row.tokens, error: row.error }));
      return row;
    });
    const organizations = rows.map(r => ({ taskId: r.taskId, score: r.score, organization: r.organization }));
    await save(join(dir, 'organizations.json'), organizations);
    return { organizationSummary: summarizeOrganizations(organizations), score: mean(rows.map((r) => r.score)), meanTokens: mean(rows.map((r) => r.tokens)),
      tokens: rows.reduce((n, r) => n + r.tokens, 0),
      failures: rows.flatMap((r, i) => r.score ? [] : [{ taskId: r.taskId, question: tasks[i].prompt,
        expected_output: tasks[i].answer, prediction: r.answer, error: r.error, organization: r.organization }]) };
  }
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body || '{}');
      let result: unknown;
      if (req.url === '/bootstrap') result = { config, composition: initialComposition, prompts: programPrompts, organization: initialOrganization, interface: policyInterface };
      else if (req.url === '/propose') {
        const usagePath = join(out, 'optimizer-calls', `${randomUUID()}.json`);
        const agents = makeAgents(async (records) => save(usagePath, { round: input.round, records }), { round: input.round, phase: 'optimizer' });
        try {
          let proposal = (await agents.structured('aflow-optimizer', input.prompt, {}, proposalSchema, runtimeConfig.episode)).value;
          for (let attempt = 0; ; attempt++) {
            try { const { modification: _, ...artifact } = proposal; candidate({ id: `s${input.round}`, ...artifact }); break; }
            catch (error) {
              await append(join(out, 'contract-errors.jsonl'), { round: input.round, attempt, proposal, error: String(error) });
              if (attempt >= 2) throw error;
              proposal = (await agents.structured('aflow-contract-repair',
                'Repair only the composition/interface contract. Preserve the proposed optimization and substantive prompts. Do not solve any benchmark or optimize answers. Return the complete corrected artifact.\n' + policyInterface,
                { proposal, error: String(error) }, proposalSchema, runtimeConfig.episode)).value;
            }
          }
          validateComposition(proposal.composition);
          result = proposal;
          await append(join(out, 'proposals.jsonl'), { round: input.round, ...proposal });
        } finally {
          await append(join(out, 'optimizer-usage.jsonl'), { round: input.round, records: agents.provider.records });
        }
      } else if (req.url === '/evaluate') {
        if (!Number.isInteger(input.round) || input.round < 1 || !Number.isInteger(input.repeat) || input.repeat < 0 || input.repeat >= config.validationRounds)
          throw new Error('Invalid round/pass');
        result = await evaluation(input.round, input.repeat, candidate(input.strategy));
      } else if (req.url === '/freeze') {
        const strategy = candidate(input.strategy);
        const bundle: Bundle = { version: 3, executionVersion, dittoVersion: '0.1.1', pythonImage: image, strategy,
          pool: strategy.organization!.initialAgents, model: options.model, config: runtimeConfig,
          searchDataHash: digest(tasks), selectionTaskIds: tasks.map((t) => t.id),
          selectionPromptHashes: tasks.map((t) => digest(promptKey(t))),
          selectionGroups: [...new Set(tasks.map((t) => t.group ?? t.id))],
          experimentalScope: 'standard-isolated-state-v2' };
        await save(join(out, 'best.json'), bundle);
        await save(join(out, 'organization.json'), { organization: strategy.organization, composition: strategy.composition,
          prompts: strategy.prompts, note: 'Reusable MAS specification. Task-specific graphs are in round/pass organizations.json and execution logs; no episode memory is imported into inference.' });
        await save(join(out, 'summary.json'), { selectedRound: input.round, validationAccuracy: input.score,
          validationRounds: config.validationRounds, protocol: manifest.protocol, stopReason: input.stopReason, frozenBeforeTest: true });
        result = { frozen: true };
      } else throw new Error('Unknown route');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error),
      fatal: req.url === '/propose' && !(error instanceof PolicyContractError),
      unavailable: error instanceof ProviderFailure || /HTTP \d{3}|Provider returned invalid JSON/.test(String(error)) })); }
  });
  server.requestTimeout = 0;
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Bridge failed to listen');
  try {
    await new Promise<void>((done, reject) => {
      const child = spawn(options.python, [controller, `http://127.0.0.1:${address.port}`, source, out], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? done() : reject(new Error(`AFlow controller exited ${code}`)));
    });
  } finally { server.close(); }
}
