import { dittoGuide } from './ditto-guide.js';
import { createServer } from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from 'node:util';
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { DittoAgents, MeteredProvider, httpProvider, executionVersion, arithmeticTool, type ModelSettings } from "./ditto.js";
import { pythonImage, createPythonTool, createBenchmarkWebTool } from './python-tool.js';
import { strategySchema, organizationSchema, rootProfile, searchConfigSchema, type Task, type Strategy } from "./types.js";
import { AGENT_PROMPT, FACTORY_PROMPT, REVIEW_PROMPT } from "./prompts.js";
import { readTasks, assertDatasetRole, promptKey } from "./data.js";
import { checkScoring, grade, gradingIdentity, GradingFailure } from "./grading.js";
import { append, save, digest, mean } from "./util.js";
import { PolicyContractError } from "./strategy-program.js";
import { organizationEvidence, summarizeOrganizations } from "./organization.js";
import { initialAgentComposition, initialVerifierComposition, validateComposition } from "./composition.js";
import { ProviderFailure } from "./provider-progress.js";
import { checkpointExecution } from "./evaluation.js";
import { validateToolLibrary } from './tool-program.js';
import { automationTools, executeBenchmark } from './benchmark-environment.js';
import type { Bundle } from "./search.js";

import { benchmarkSeeds, textOrganization, textPrompts } from './aflow-seed.js';

class GenerationExhausted extends Error {}

export const aflowConfigSchema = z.object({
  seed: z.number().int().default(42), maxRounds: z.number().int().positive().nullable().default(null),
  validationRounds: z.number().int().positive().default(5),
  concurrency: z.number().int().positive().default(50),
  maxOutputTokens: z.number().int().positive().default(393216),
  initializations: z.array(z.string().min(1)).length(1).default(['dynamic-policy']),
}).strict();

const solverProfile = { ...rootProfile, tools: ['arithmetic', 'python'], reasoning: 'react' as const,
  nodes: ['CONTEXT.LOAD', 'INFER.REASONING.SAMPLE', 'INTERACTION.ACT.TOOL', 'INTERACTION.OBSERVE'] as const };
const { id: _rootId, ...solverCapability } = solverProfile;
export const legacyOrganization = organizationSchema.parse({
  initialAgents: [solverProfile], initialBindings: { root: 'solver' },
  agentTemplates: [
    { id: 'solver', description: 'General reasoning with explicit tool/observation loop and evidence integration.',
      profile: solverCapability, composition: initialAgentComposition },
    { id: 'verifier', description: 'Independently verify a concrete gap against the original problem.',
      profile: { ...solverCapability, tools: [], nodes: ['INFER.REASONING.REFLECT'], reasoning: 'cot',
        objective: 'Check the assigned gap and return concrete verification evidence.',
        capability: 'Independent verification of assumptions, cases and calculations',
        expected_output: 'A verification artifact identifying supported conclusions and remaining errors.',
        stop_condition: 'The assigned verification is complete or its unresolved obstacle is explicit.' },
      composition: initialVerifierComposition },
  ],
});
export const legacyPrompts = {
  agent: AGENT_PROMPT, factory: FACTORY_PROMPT, review: REVIEW_PROMPT,
  integrate: AGENT_PROMPT,
  retrieve: 'Select one existing agent whose capability is relevant to the deficit; return agent_id or null. No confidence scores.',
};
export const initialOrganization = textOrganization;
export const programPrompts = textPrompts;
const proposalSchema = z.object({
  modification: z.string().min(1), composition: z.string().min(1),
  prompts: strategySchema.shape.prompts.unwrap(),
  organization: organizationSchema.safeExtend({
    agentTemplates: organizationSchema.shape.agentTemplates.unwrap(),
    initialBindings: organizationSchema.shape.initialBindings.unwrap(),
  }),
}).strict();

export const policyInterface = `SEARCH OBJECT: a complete dynamic MAS built with the published Ditto graph(), loop(), graphStep() APIs. Return composition (JavaScript source), organization (initialAgents, initialBindings, agentTemplates, toolCreation:true) and all five prompts. composition executes once per task and RETURNS loop({id, plan: function* (ctx) {...}}). The generator must yield* graphStep(nativeGraph, input) and return the final answer STRING. Nested generators and yield* allow different agent loops to be serial, interleaved, recursive, or combined into one DAG. Do not reduce this to an outer action selector or a fixed shared agent implementation.
SINGLE-ROOT SEARCH: every candidate and every inference episode starts with exactly one initial agent, id root. All other agents must be derived by the candidate's executable policy. Different MAS layouts are alternative descendants in ONE search tree, not independent initialization trees or pre-created populations. The parent is the measured earlier node selected by AFlow, not a fresh seed. Branching may revisit an earlier parent; it need not form a linear chain of the most recent candidates.
STRUCTURAL EXPLORATION: use the supplied search_branch_history and parent execution to choose a concrete, underexplored change that addresses measured failures or inefficiency. Possible directions include conditional hierarchical decomposition, independent branches and merging, cross-agent context exchange, heterogeneous reasoning/tool loops, and reusable tools for repeated computations or API sequences. These are exploration suggestions, not fixed topologies or mandatory tools. Do not repeatedly propose only a verifier or role-prompt rename. A structural change must alter executable nodes, capabilities, bindings or control conditions and then be measured. Study the detailed Ditto contracts below before selecting each member's nodes and their configuration. Preserve useful parent-generated programs as generalized editable templates when justified, and iterate their code plus the surrounding derivation rule; leaving every concrete graph to an unchanged generic factory is not evidence of structural optimization.
DYNAMIC CONTROL CONTRACT: preserve an executable feedback-conditioned derivation policy in each candidate, including stopping, reuse versus generation, agent internal graphs, capability changes and evidence routing. Initial topology is a starting state; later states may differ per task. The entire initial graph AND subsequent control program are editable and inherited. Do not replace this with an unconditional extra reviewer or a fixed population; static schemes are ablations. Keep decisions observable via ctx.recordDecision, and use ctx.bindProgram to revise an existing agent without resetting the task world. A dynamic policy may legitimately stop with no new agent when evidence is sufficient.
JOINT SEARCH: optimize (1) individual agent graphs/loops and capabilities, (2) a reusable task-family template library, and (3) dynamic MAS topology, selection, spawning, evidence routing and stopping, and (4) parameterized reusable tools and task-local tool creation. The library supplements the full MAS program; never replace the MAS with a fixed list of independent agents.
Agent roles are open-ended: use task decomposition, API discovery, entity resolution, dependency scheduling, effect verification, recovery, alternative reasoning methods or tool use when supported. Optimize the current task family, not a remembered mathematical task. A verifier is only one possible program. Prefer full text for mathematical solutions; use native structured schemas only where the node requires them. Review and integrate complete derivations, not just final answers or self-reported deficits. Use observed failures to decide whether to improve a root/subagent graph, add a distinct specialist, or change the MAS routing/derivation policy. If parent execution has no spawning, consider a concrete unresolved deficit and a complementary specialist instead of repeatedly adding root samples. Explore tree-shaped hierarchies, independent parallel branches with merge points, cross-checking diamonds, and node-level weaving across agents, as well as serial workflows. Spawn only where the task or measured deficit justifies it; topology and branch count are searched choices. Do not force spawning on every task or claim template benefit from mere usage. Fully validate the resulting MAS with its library as one candidate; evaluate accuracy and actual node/lifecycle cost. Keep one focused AFlow modification (including the template and routing needed for that single modification). No test-based library selection or cross-task mutable state.
Entire graphs, agent-specific loops, profiles, bindings and dynamic derivation decisions are inherited as the parent artifact, along with measured node/lifecycle/graph feedback. Preserve useful structures. Parent reusableCandidates are observed search-time artifacts, not automatically validated reusable assets: generalize successful program/tool definitions without task literals, explicitly incorporate useful ones into agentTemplates/toolLibrary, and re-evaluate the entire candidate. Use failure examples to repair contracts. Keep the existing useful outer routing when changing one subagent; use the shared Ditto guide in new stages. Make one focused modification using the original AFlow feedback/experience method; return complete artifacts, not patches. No benchmark answers or task-specific solution tables in code/prompts/profiles. No test data is available to search. Static graph structure may be part of the reusable program, but the dynamic plan controls when and how to extend it.
` + dittoGuide.text;

export function assertSingleRoot(organization: Strategy['organization']) {
  if (organization?.initialAgents.length !== 1 || organization.initialAgents[0].id !== 'root')
    throw new PolicyContractError('Every MFlow MAS must start with exactly one root agent; derive all other members through the searched policy');
}

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
  const seeds = benchmarkSeeds(tasks, config.initializations), seed = seeds[0];
  assertSingleRoot(seed.organization);
  const workflow = tasks[0].metric === 'automationbench';
  const webSearch=tasks[0].metric==='hle';
  const allowedTools = workflow ? [...automationTools, 'python'] : ['arithmetic', 'python', ...(webSearch?['web_search']:[])];
  const taskInterface = policyInterface + '\nDeployment availableTools: ' + allowedTools.join(', ') + '. create_tool is provided to every agent.';
  await checkScoring(tasks);
  const runtimeConfig = unrestrictedConfig(config.maxOutputTokens);
  const image = await pythonImage();
  const makeAgents = (observe?: (records: MeteredProvider['records']) => Promise<void>, context: Record<string, unknown> = {}) =>
    new DittoAgents(new MeteredProvider(httpProvider(options.model, process.env.MFLOW_API_KEY ?? '', {
      onProgress: progress => save(join(out, 'requests', `${progress.id}.json`), { ...context, ...progress }),
    }), undefined, observe), options.model, [...(workflow ? [] : [arithmeticTool]), createPythonTool(image), ...(webSearch?[createBenchmarkWebTool()]:[])]);
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
  const manifest = { protocol: 'official-aflow-ditto-library-v2', transport: 'ditto-public-stream-v1', seedProvenance: seed.provenance, config, model: options.model,
    dittoGuideHash: dittoGuide.sha256,
    ...await gradingIdentity(tasks),
    dataHash: digest(tasks), source: lock, code, pythonImage: image, webSearch,
    controller: digest(await readFile(controller, 'utf8')),
    controllerEvidence: digest(await readFile(resolve('scripts/search_evidence.py'), 'utf8')),
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
    await save(join(out, 'ditto-guide.json'), dittoGuide);
  }
  const candidate = (value: unknown): Strategy => {
    const parsed = strategySchema.parse({ rules: [{ id: 'unused', status: 'NONE', guards: [], action: 'STOP' }], fallback: 'STOP', ...(value as object) });
    if (!parsed.composition || !parsed.prompts) throw new Error('Complete Ditto composition and prompts required');
    if (!parsed.organization) throw new Error('Complete organization required');
    assertSingleRoot(parsed.organization);
    parsed.organization.toolCreation = true;
    validateComposition(parsed.composition);
    if (!parsed.organization.agentTemplates || !parsed.organization.initialBindings)
      throw new PolicyContractError('Complete reusable agentTemplates and initialBindings required');
    for (const template of parsed.organization.agentTemplates) validateComposition(template.composition);
    const availableTools = validateToolLibrary(parsed.organization.toolLibrary ?? [], allowedTools);
    availableTools.add('create_tool');
    const profiles = [...parsed.organization.initialAgents, ...parsed.organization.agentTemplates.map(t => ({ ...t.profile, id: t.id }))];
    for (const profile of profiles) {
      if (!profile.nodes?.length || profile.id.includes('/')) throw new Error('Every native agent requires node capabilities and an ID without /');
      if (profile.tools.some(t => !availableTools.has(t))) throw new Error('Unknown organization tool');
    }
    return parsed;
  };
  type Row = { taskId: string; score: number; f1?: number; answer: string; tokens: number; actualTokens?: number | null; solutionEvidence?: { agentId: string; artifacts: unknown[] }[]; toolEvidence?: unknown[]; error?: string; organization?: ReturnType<typeof organizationEvidence> };
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
      const execution = await checkpointExecution(join(dir, `${index}.execution.json`), task.id, async () => {
        // Native generation retries do not include grading or persistence failures.
        for (let attempt = 0; ; attempt++) {
          await append(join(dir, `${index}.attempts.jsonl`), { event: 'started', phase: 'generation', attempt, at: new Date().toISOString() });
          try {
            return await executeBenchmark(task, agents, strategy, runtimeConfig.episode);
          } catch (error) {
            await append(join(dir, `${index}.attempts.jsonl`), { event: 'failed', phase: 'generation', attempt, error: String(error), at: new Date().toISOString() });
            if (error instanceof PolicyContractError || error instanceof ProviderFailure || /HTTP \d{3}|Provider returned invalid JSON/.test(String(error))) throw error;
            if (attempt >= 4) throw new GenerationExhausted(String(error));
            await delay(1000);
          } finally {
            await save(usagePath, [...previousUsage, ...agents.provider.records]);
          }
        }
      }).catch(error => {
        // An invalid searched program is candidate feedback, not a provider or
        // grader outage. Persist it once so resume does not retry it forever.
        if (!(error instanceof GenerationExhausted || error instanceof PolicyContractError)) throw error;
        row.error = error.message;
        return undefined;
      });
      try {
        if (execution) row = { taskId: task.id, ...await grade(task, execution.answer, execution, agents), answer: execution.answer,
          tokens: agents.provider.tokens, actualTokens: execution.actualTokens, organization: organizationEvidence(execution),
          error: execution.executionError, toolEvidence: execution.toolEvents,
          solutionEvidence: execution.outputs.map(({ agentId, output }) => ({ agentId, artifacts: output.artifacts })) };
      } catch (error) {
        await append(join(dir, `${index}.attempts.jsonl`), { event: 'failed', phase: 'grading', error: String(error), at: new Date().toISOString() });
        throw error;
      }
      row.tokens = agents.provider.tokens + previousUsage.reduce((n, r) => n + r.charged, 0);
      await save(path, row);
      await rm(join(dir, `${index}.execution.json`), { force: true });
      console.log(JSON.stringify({ round: number, repeat, task: index + 1, score: row.score, tokens: row.tokens, error: row.error }));
      return row;
    });
    const organizations = rows.map(r => ({ taskId: r.taskId, score: r.score, organization: r.organization }));
    await save(join(dir, 'organizations.json'), organizations);
    return { organizationSummary: summarizeOrganizations(organizations), score: mean(rows.map((r) => r.f1 ?? r.score)), meanTokens: mean(rows.map((r) => r.tokens)),
      tokens: rows.reduce((n, r) => n + r.tokens, 0),
      failures: rows.flatMap((r, i) => r.score ? [] : [{ taskId: r.taskId, question: tasks[i].prompt,
        expected_output: tasks[i].answer, prediction: r.answer, solutionEvidence: r.solutionEvidence, toolEvidence:r.toolEvidence, error: r.error, organization: r.organization }]) };
  }
  const server = createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const input = JSON.parse(body || '{}');
      let result: unknown;
      if (req.url === '/bootstrap') result = { config, dataset: seed.dataset, questionType: seed.kind,
        composition: seed.composition, prompts: seed.prompts, organization: seed.organization, seeds,
        interface: taskInterface + `\nCURRENT TASK FAMILY: ${seed.kind}. Follow the dataset-specific output contract in the inherited prompts. Do not impose mathematical boxed answers on other tasks. Workflow tools share one fresh official world per task; use inspection or repair, never duplicate a write merely to compare wording.` };
      else if (req.url === '/propose') {
        const usagePath = join(out, 'optimizer-calls', `${randomUUID()}.json`);
        const agents = makeAgents(async (records) => save(usagePath, { round: input.round, records }), { round: input.round, phase: 'optimizer' });
        try {
          let proposal = (await agents.structured('aflow-optimizer', input.prompt + '\nContract reminder: the outer MAS receives the global ctx, not an agent-local ctx; ctx.self/evidence/prompt exist only inside a bound agent program. Outer code starts with root and returns an answer string; runAgent returns AgentOutput directly (candidate_answer, artifacts, open_deficits), not {output:...}. Preserve and evolve the parent dynamic derivation policy together with MAS routing, agent profiles and internal graphs. Do not accidentally replace the outer MAS with a solver template.', {}, proposalSchema, runtimeConfig.episode)).value;
          for (let attempt = 0; ; attempt++) {
            try { const { modification: _, ...artifact } = proposal; candidate({ id: `s${input.round}`, ...artifact }); break; }
            catch (error) {
              await append(join(out, 'contract-errors.jsonl'), { round: input.round, attempt, proposal, error: String(error) });
              if (attempt >= 2) throw error;
              proposal = (await agents.structured('aflow-contract-repair',
                'Repair only the composition/interface contract. Preserve the proposed optimization and substantive prompts. Do not solve any benchmark or optimize answers. Return the complete corrected artifact.\n' + taskInterface,
                { proposal, error: String(error) }, proposalSchema, runtimeConfig.episode)).value;
            }
          }
          proposal.organization.toolCreation = true;
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
      } else if (req.url === '/freeze' || req.url === '/checkpoint-round') {
        const strategy = candidate(input.strategy);
        const bundle: Bundle = { version: 3, executionVersion, dittoVersion: '0.1.2', dittoGuide, pythonImage: image, webSearch, strategy,
          pool: strategy.organization!.initialAgents, model: options.model, config: runtimeConfig,
          searchDataHash: digest(tasks), selectionTaskIds: tasks.map((t) => t.id),
          selectionPromptHashes: tasks.map((t) => digest(promptKey(t))),
          selectionGroups: [...new Set(tasks.map((t) => t.group ?? t.id))],
          experimentalScope: 'standard-isolated-state-v2' };
        if (req.url === '/checkpoint-round') {
          if (!Number.isInteger(input.round) || input.round < 1) throw new Error('Invalid completed round');
          await save(join(out, 'round-candidates', `round-${input.round}.json`), bundle);
          result = { exported: true };
        } else {
        await save(join(out, 'best.json'), bundle);
        await save(join(out, 'agent-library.json'), { templates: strategy.organization!.agentTemplates, initialBindings: strategy.organization!.initialBindings, selectedRound: input.round, strategyHash: digest(strategy), frozenBeforeTest: true });
        await save(join(out, 'tool-library.json'), { tools: strategy.organization!.toolLibrary ?? [], selectedRound: input.round, strategyHash: digest(strategy), frozenBeforeTest: true });
        await save(join(out, 'organization.json'), { organization: strategy.organization, composition: strategy.composition,
          prompts: strategy.prompts, note: 'Reusable MAS specification. Task-specific graphs are in round/pass organizations.json and execution logs; no episode memory is imported into inference.' });
        await save(join(out, 'summary.json'), { selectedRound: input.round,
          ...(tasks[0].metric === 'drop' ? { validationMeanF1: input.score } : { validationAccuracy: input.score }),
          validationRounds: config.validationRounds, protocol: manifest.protocol, stopReason: input.stopReason, frozenBeforeTest: true });
        result = { frozen: true };
        }
      } else throw new Error('Unknown route');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(result));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: String(error),
      fatal: error instanceof GradingFailure || req.url === '/evaluate' || (req.url === '/propose' && !(error instanceof PolicyContractError)),
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
