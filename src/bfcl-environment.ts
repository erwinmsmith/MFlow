import { z } from 'zod';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { RegisteredTool } from '@codesoul-co/ditto';
import { benchmarkHome, extraBenchmarkIdentity } from './benchmark-hub.js';
import type { Task, Execution } from './types.js';

export const bfclTools = ['bfcl_state', 'bfcl_call', 'bfcl_respond'];
export const bfclInstruction = `Complete the entire multi-turn tool conversation in the official BFCL simulated environment.
First call bfcl_state to read the CURRENT user message, public history and available function schemas. Future user messages and withheld functions are not available yet.
Call bfcl_call with the current turn number and calls:[{name,arguments}] using exact documented function names, parameter names and JSON values. A batch is one official action step; batch independent calls, but wait for results before dependent calls. Never invent missing functions or argument values. Ask for missing user information when needed.
Call bfcl_respond with the current turn and your factual response or clarification question when this user turn is finished or blocked. It reveals the next user turn, or complete:true. Continue until complete:true. Returning prose from the agent alone does NOT submit a user response or advance the conversation. The official per-turn action-step limit applies equally to every method.
All agents share one world and conversation: call bfcl_state before acting on inherited context, preserve successful effects, and never duplicate writes. Once complete:true, stop changing the world. Specialize agents in dependency planning, schema/parameter checking, execution or state verification as useful; planning and ranking stages must obey their control schemas and not execute actions. Only public user messages and actual tool observations are evidence; hidden initial state and grading references are unavailable.
The bfcl_respond message is the user-facing answer. Your outer model response must follow the calling framework's exact requested format, including JSON Action/ActionInput or observer envelopes when requested. Completing a conversation does not waive those output schemas; put factual results inside the required fields.`;

export function bfclPython() { return process.env.MFLOW_BFCL_PYTHON ?? resolve(benchmarkHome(), 'environments/bfcl/bin/python'); }
let ready: Promise<any> | undefined;
export function checkBFCL() { return ready ??= (async () => {
  const lock = await extraBenchmarkIdentity('bfcl');
  const official = resolve(benchmarkHome(), lock.source.path);
  for (const [path, hash] of Object.entries(lock.source.sha256)) {
    if (createHash('sha256').update(await readFile(resolve(official, path))).digest('hex') !== hash)
      throw new Error('Pinned BFCL source changed: ' + path);
  }
  return { lock, official };
})(); }

export async function openBFCL(task: Task) {
  const { official } = await checkBFCL();
  const child = spawn(bfclPython(), ['benchmark-hub/bfcl_environment.py', '--official', official, '--task', task.reference!.bfclTaskId!], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', closed = false;
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const failed = new Promise<never>((_, reject) => { child.once('error', reject); child.stdin.once('error', reject); });
  failed.catch(() => {});
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  let queue: Promise<unknown> = Promise.resolve();
  const close = () => { if (!closed) { closed = true; child.stdin.end(); child.kill(); } };
  const request = <T>(input: object): Promise<T> => {
    const run = queue.then(async () => {
      const abort = new AbortController();
      try {
        if (closed) throw new Error('BFCL environment closed');
        child.stdin.write(JSON.stringify(input) + '\n');
        const line = await Promise.race([lines.next(), failed, delay(60_000, undefined, { signal: abort.signal }).then(() => { close(); throw new Error('BFCL environment timed out'); })]);
        if (line.done) throw new Error('BFCL environment exited: ' + stderr);
        const value = JSON.parse(line.value);
        if (!value.ok) throw new Error(value.error);
        return value.result as T;
      } finally { abort.abort(); }
    });
    queue = run.catch(() => {});
    return run;
  };
  const definitions = [
    { name: 'bfcl_state', description: 'Read current public conversation, turn, available function schemas and completion flag.', properties: {}, required: [] },
    { name: 'bfcl_call', description: 'Execute documented official functions in the current turn; dependent calls must wait for observations.', properties: { turn: { type: 'integer' }, calls: { type: 'array', minItems: 1, items: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false } } }, required: ['turn', 'calls'] },
    { name: 'bfcl_respond', description: 'Submit the current-turn user response or clarification question and reveal the next turn. Continue until complete:true.', properties: { turn: { type: 'integer' }, message: { type: 'string' } }, required: ['turn', 'message'] },
  ];
  const tools: RegisteredTool[] = definitions.map(d => ({
    name: d.name, description: d.description,
    inputSchema: z.record(z.string(), z.json()).parse({ type: 'object', properties: d.properties, required: d.required, additionalProperties: false }),
    effects: d.name === 'bfcl_state' ? ['read'] : ['read', 'write'],
    validate: args => { z.record(z.string(), z.json()).parse(args); },
    async execute(args) {
      const result = await request({ op: 'call', name: d.name, arguments: args });
      return { status: 'success', content: JSON.stringify(result) };
    },
  }));
  try { await request({ op: 'state' }); return { tools, request, close }; }
  catch (e) { close(); throw e; }
}

export async function gradeBFCL(task: Task, execution?: Execution) {
  if (!execution?.environment) throw new Error('BFCL requires a saved official conversation checkpoint');
  const env = await openBFCL(task);
  try { return await env.request<{score: 0|1; partialCredit: number; errorType?: string}>({ op: 'grade', ...execution.environment }); }
  finally { env.close(); }
}
