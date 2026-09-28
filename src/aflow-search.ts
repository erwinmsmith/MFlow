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
import { strategySchema, organizationSchema, rootProfile, searchConfigSchema, type Task, type Strategy } from "./types.js";
import { AGENT_PROMPT, FACTORY_PROMPT, REVIEW_PROMPT } from "./prompts.js";
import { readTasks, assertDatasetRole, promptKey } from "./data.js";
import { checkScoring, grade } from "./grading.js";
import { append, save, digest, mean } from "./util.js";
import { validateProgram, normalizeProgram, PolicyContractError } from "./strategy-program.js";
import { organizationEvidence, summarizeOrganizations } from "./organization.js";
import { ProviderFailure } from "./provider-progress.js";
import type { Bundle } from "./search.js";

export const aflowConfigSchema = z.object({
  seed: z.number().int().default(42), maxRounds: z.number().int().positive().nullable().default(null),
  validationRounds: z.number().int().positive().default(5),
  concurrency: z.number().int().positive().default(50),
  maxOutputTokens: z.number().int().positive().default(393216),
}).strict();

export const initialOrganization = { initialAgents: [{ ...rootProfile,
  tools: ["arithmetic", "python"], reasoning: "react" as const,
}] };
export const programPrompts = {
  agent: AGENT_PROMPT, factory: FACTORY_PROMPT, review: REVIEW_PROMPT,
  integrate: AGENT_PROMPT,
  retrieve: 'Select one existing agent whose capability is relevant to the deficit; return agent_id or null. No confidence scores.',
};
const proposalSchema = z.object({
  modification: z.string().min(1), program: z.string().min(1),
  prompts: strategySchema.shape.prompts.unwrap(),
  organization: organizationSchema,
}).strict();

export const policyInterface = `SEARCH OBJECT: a complete MAS specification: organization.initialAgents (reusable heterogeneous AgentProfiles), five prompts, and a dynamic JavaScript policy function BODY, for example: return {action: "STOP"}; . A complete (state) => Decision function is also accepted and normalized to a body.
It is called after Root solves once, and after every organization action. Use arbitrary conditionals, array operations, loops and local helper functions. No pre-enumerated edits or role catalogue.
State: task {id,prompt}, step, usage {tokens,calls}, agents [{id,status,depth,turns,stalled,reviewed,challenged,profile,assigned?}], deficits [{id,text,owner,status,source?,artifactIds,deliveredIds}], outputs [{agentId,output}], artifacts [{id,source,type,content,deficitRefs}], edges and toolEvents. Profiles contain capability, objective, private_context, tools and reasoning. All are fresh task-local data. No reference answers are available at execution.
Decision: {action, agentId?, deficitId?, request?, profile?, ruleId?}.
Each initial AgentProfile has id, objective, capability, private_context, tools, reasoning (cot/long-cot/react), expected_output, stop_condition. Exactly one id is root; root starts active and solves once, others start dormant. These task-independent capability definitions are inherited by children and frozen for inference. Preserve useful profiles when editing one part of the parent. No predefined role catalogue or fixed population size. Profiles must not contain benchmark answers, task-specific solutions or episodic memory.
DERIVE may supply profile (all AgentProfile fields except id) to instantiate a specifically designed capability; without profile, the Factory designs it for this task. RECONFIGURE with agentId and profile changes an existing agent's capability/objective/tools/reasoning while retaining identity, history and assignments; it does not execute the agent. REACTIVATE with deficitId and optional agentId selects a dormant member and assigns it. Initial population, task-local profile changes, recursive delegation, routing and deactivation jointly determine the evolving MAS, not just the spawn trigger.
Deficit status values are exactly MISSING, LATENT, ACTIVE, DELIVERED, RESOLVED (uppercase); there is no 'open' status. An unresolved deficit has status !== 'RESOLVED'. Every deficit has an owner. Return a Decision object on every path, never undefined. request is permitted ONLY for DERIVE without deficitId. For CONTINUE-specific guidance, edit the agent/integrate prompt; do not attach request to CONTINUE.
CONTINUE executes agentId (default root), integrating delivered evidence. REVIEW executes a review prompt. DERIVE with deficitId creates an agent for that deficit; DERIVE with request and agentId creates a NEW open semantic assignment owned by that agent. The Factory generates its capability, objective, context and tools unless profile is supplied. CONNECT with deficitId delivers source artifacts to the owner; CONTINUE must then consume them. ACTIVE with undelivered artifacts needs CONNECT before owner integration; do not repeatedly continue an owner who cannot see child evidence. LATENT requires REACTIVATE to reuse that source. If an active child has produced no artifact, continue/reconfigure that child or request another approach. Child profiles and tool evidence are visible in state and measured organization feedback. REACTIVATE resumes a dormant deficit source. DORMANT deactivates agentId; DISCONNECT removes delivery links; STOP returns Root's latest answer. CHALLENGE is a convenience independent-check action; DERIVE request is fully open-ended.
To spawn several agents or recurse, inspect state and issue successive decisions. Return one action per invocation, route and integrate the results, then terminate. A strategy program cannot itself call a model, tool, filesystem, network, import, clock or process. Agent execution is owned by published Ditto.
Return the entire organization, program and all five editable prompts: agent, factory, review, integrate, retrieve. These fields replace the corresponding inference instructions. Factory must select tools from available_tools: arithmetic and python (isolated Python 3 standard library, print results, no network or host files). Use react reasoning for tools. Agent outputs remain structured: claims, artifacts, open_deficits, resolved_deficits, candidate_answer. Preserve the schema contract; only owners can resolve their deficits. There is no fixed sampling count, spawned-agent count, depth or episode token limit. Do not embed validation answers or task IDs into the policy or prompts.
This interface replaces AFlow's Python imports/Custom prompt representation. All five prompt fields may be optimized. Make one focused change per candidate, with the original AFlow guidance of no more than five changed code lines and graph complexity no more than ten. Emit complete artifacts, not patches.`;

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
  const manifest = { protocol: 'official-aflow-mas-v2', transport: 'ditto-public-stream-v1', config, model: options.model,
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
    if (!parsed.program || !parsed.prompts) throw new Error('Complete strategy program and prompts required');
    if (!parsed.organization) throw new Error('Complete organization required');
    validateProgram(parsed.program, parsed.organization.initialAgents);
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
      if (req.url === '/bootstrap') result = { config, program: 'return { action: "STOP" };', prompts: programPrompts, organization: initialOrganization, interface: policyInterface };
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
                'Repair only the program/interface contract. Preserve the proposed optimization and substantive prompts. Do not solve any benchmark or optimize answers. Return the complete corrected artifact.\n' + policyInterface,
                { proposal, error: String(error) }, proposalSchema, runtimeConfig.episode)).value;
            }
          }
          proposal.program = normalizeProgram(proposal.program);
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
        await save(join(out, 'organization.json'), { organization: strategy.organization, program: strategy.program,
          prompts: strategy.prompts, note: 'Reusable MAS specification. Task-specific graphs are in round/pass organizations.json and execution logs; no episode memory is imported into inference.' });
        await save(join(out, 'summary.json'), { selectedRound: input.round, validationAccuracy: input.score,
          validationRounds: config.validationRounds, protocol: manifest.protocol, stopReason: input.stopReason, frozenBeforeTest: true });
        result = { frozen: true };
      } else throw new Error('Unknown route');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error), unavailable: error instanceof ProviderFailure || /HTTP \d{3}|Provider returned invalid JSON/.test(String(error)) })); }
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
