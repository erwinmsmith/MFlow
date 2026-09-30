import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RegisteredTool } from '@codesoul-co/ditto';
import { z } from 'zod';
import { benchmarkHome, extraBenchmarkIdentity } from './benchmark-hub.js';
import { DittoAgents } from './ditto.js';
import { OrganizationRuntime } from './runtime.js';
import type { Task, Strategy, Limits, Execution } from './types.js';

export const automationTools = ['api_search', 'api_fetch', 'base64_encode'];
const argumentsSchemas = {
  api_search: z.object({ query: z.string(), top_k: z.number().int() }).strict(),
  api_fetch: z.object({ method: z.string(), url: z.string(), params: z.string().nullable(), body: z.string().nullable() }).strict(),
  base64_encode: z.object({ text: z.string() }).strict(),
};
let ready: Promise<unknown> | undefined;
export function automationPython() {
  return process.env.MFLOW_AUTOMATION_PYTHON ?? resolve(benchmarkHome(), 'collections/automationbench/official/.venv/bin/python');
}
export function checkAutomation() { return ready ??= (async () => {
  const lock = await extraBenchmarkIdentity('automationbench');
  await promisify(execFile)(automationPython(), ['-c', 'from automationbench.runner import AutomationBenchEnv; from automationbench.rubric import partial_credit'], {timeout: 30_000});
  return lock;
})(); }

// Reuse only Python imports/task builders, never task worlds, model output or grading results.
const idle: ReturnType<typeof bridge>[] = [];
function bridge() {
  const python = automationPython();
  const child = spawn(python, ['benchmark-hub/automation_bridge.py'], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AUTOMATIONBENCH_STRICT_ASSERTIONS: '1' } });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const failed = new Promise<never>((_, reject) => { child.once('error', reject); });
  failed.catch(() => {});
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let queue: Promise<unknown> = Promise.resolve();
  const request = <T>(input: object): Promise<T> => {
    const run = queue.then(async () => {
      const abort = new AbortController();
      try {
        child.stdin.write(JSON.stringify(input) + '\n');
        const line = await Promise.race([lines.next(), failed,
          delay(60_000, undefined, { signal: abort.signal }).then(() => { child.kill(); throw new Error('AutomationBench environment timed out'); })]);
        if (line.done) throw new Error(`AutomationBench environment exited: ${stderr}`);
        const value = JSON.parse(line.value);
        if (!value.ok) throw new Error(value.error);
        return value.result as T;
      } finally { abort.abort(); }
    });
    queue = run.catch(() => {});
    return run;
  };
  return { request, kill: () => { child.stdin.end(); child.kill(); }, alive: () => child.exitCode === null && !child.killed };
}

export async function openAutomation(task: Task) {
  await checkAutomation();
  const process = idle.pop() ?? bridge();
  const { request } = process;
  let released = false;
  const close = () => {
    if (released) return;
    released = true;
    if (!process.alive()) return;
    idle.push(process);
    // Retire imports after the next task/regrade had an opportunity to reuse them.
    setTimeout(() => { const index = idle.indexOf(process); if (index >= 0) { idle.splice(index, 1); process.kill(); } }, 1000).unref();
  };
  try {
    const start = await request<{ tools: { function: { name: string; description: string; parameters: Record<string, unknown> } }[] }>(
      { op: 'start', taskId: task.reference!.automationTaskId });
    const tools: RegisteredTool[] = start.tools.map(({ function: t }) => ({
      name: t.name, description: t.description, inputSchema: z.record(z.string(), z.json()).parse(t.parameters),
      effects: t.name === 'api_fetch' ? ['read', 'write'] : ['read'],
      validate: args => { const schema = argumentsSchemas[t.name as keyof typeof argumentsSchemas];
        if (!schema) throw new Error('Unknown official API tool'); schema.parse(args); },
      async execute(args) {
        try {
          const result = await request<{content: string}>({ op: 'call', name: t.name, arguments: args });
          return { status: 'success', content: result.content };
        } catch (e) { return { status: 'failed', error: { code: 'BENCHMARK_TOOL', message: String(e) } }; }
      },
    }));
    return { tools, request, close };
  } catch (error) { process.kill(); throw error; }
}

/** Every attempt has a fresh official world, shared by all agents within that MAS. */
export async function executeBenchmark(task: Task, agents: DittoAgents, strategy: Strategy, limits: Limits, pool?: ConstructorParameters<typeof OrganizationRuntime>[2]): Promise<Execution> {
  const input = { id: task.id, prompt: task.prompt };
  if (task.metric !== 'automationbench') return new OrganizationRuntime(agents, limits, pool).run(strategy, input);
  const env = await openAutomation(task);
  try {
    const scoped = new DittoAgents(agents.provider, agents.model, [...agents.tools, ...env.tools]);
    const result = await new OrganizationRuntime(scoped, limits, pool).run(strategy, input);
    result.environment = await env.request({ op: 'snapshot' });
    return result;
  } finally { env.close(); }
}

export async function gradeAutomation(task: Task, execution?: Execution) {
  if (!execution?.environment) throw new Error('AutomationBench requires the saved world checkpoint, not a textual answer');
  const env = await openAutomation(task);
  try {
    return await env.request<{score: 0|1; partialCredit: number; assertions: unknown}>({ op: 'grade', ...execution.environment });
  } finally { env.close(); }
}
