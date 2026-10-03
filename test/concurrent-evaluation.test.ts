import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateConcurrent } from '../src/evaluation.js';
import { save, digest } from '../src/util.js';
import { taskSchema, type Evaluated, type Task, type Execution } from '../src/types.js';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const tasks = ['slow', 'wrong', 'failed', 'later'].map(id => taskSchema.parse({ id, prompt: id, answer: '1' }));
const row = (task: Task, score: 0 | 1 = 1): Evaluated => ({ taskId: task.id, score,
  execution: { taskId: task.id, answer: String(score) } as Execution });

test('a blocked task does not stop other episodes; resume retains wrong answers and retries only failures', async () => {
  const out = await mkdtemp(join(tmpdir(), 'mflow-concurrent-'));
  let release!: () => void, reachedLater!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const later = new Promise<void>(resolve => { reachedLater = resolve; });
  const calls: string[] = [];
  try {
    const pending = evaluateConcurrent({ out, tasks, concurrency: 2, evaluate: async task => {
      calls.push(task.id);
      if (task.id === 'slow') await gate;
      if (task.id === 'failed') throw new Error('fixture transport failure');
      if (task.id === 'later') reachedLater();
      return row(task, task.id === 'wrong' ? 0 : 1);
    } });
    await later;
    assert.deepEqual(calls, ['slow', 'wrong', 'failed', 'later']);
    release();
    const first = await pending;
    assert.equal(first.rows.length, 3); assert.equal(first.errors.length, 1);
    assert.equal(first.rows.find(r => r.taskId === 'wrong')!.score, 0);
    assert.equal(JSON.parse(await readFile(join(out, 'status.json'), 'utf8')).status, 'incomplete');
    const resumed: string[] = [];
    const result = await evaluateConcurrent({ out, tasks, concurrency: 2, evaluate: async task => {
      resumed.push(task.id); return row(task);
    } });
    assert.deepEqual(resumed, ['failed']);
    assert.deepEqual(result.rows.map(r => r.taskId), tasks.map(t => t.id));
    assert.equal(result.rows.find(r => r.taskId === 'wrong')!.score, 0);
    const logged = (await readFile(join(out, 'test.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    assert.equal(new Set(logged.map(r => r.taskId)).size, 4);
    assert.equal(logged.length, 4);
  } finally { release(); await rm(out, { recursive: true, force: true }); }
});

test('a committed row missing from the aggregate log is recovered without model execution', async () => {
  const out = await mkdtemp(join(tmpdir(), 'mflow-concurrent-crash-'));
  try {
    await mkdir(join(out, 'rows'));
    await save(join(out, 'rows', `${digest(tasks[1].id)}.json`), row(tasks[1], 0));
    const result = await evaluateConcurrent({ out, tasks: [tasks[1]], concurrency: 3,
      evaluate: async () => { throw new Error('must never execute a completed task'); } });
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].score, 0);
    assert.equal(JSON.parse(await readFile(join(out, 'status.json'), 'utf8')).status, 'completed');
  } finally { await rm(out, { recursive: true, force: true }); }
});

test('resume streams the aggregate, drops traces from memory, and still rejects changed executions', async t => {
  const out = await mkdtemp(join(tmpdir(), 'mflow-stream-resume-'));
  const original = fs.readFile;
  const mock = t.mock.method(fs, 'readFile', (...args: Parameters<typeof original>) => {
    assert.notEqual(String(args[0]), join(out, 'test.jsonl'), 'aggregate may exceed the readFile 2 GiB ceiling');
    return original(...args);
  });
  syncBuiltinESMExports();
  const result = row(tasks[0]); result.execution.tokens = 17; result.execution.toolEvents = [{ evidence: 'full trace' }];
  const evaluate = () => evaluateConcurrent({ out, tasks: [tasks[0]], concurrency: 1,
    evaluate: async () => result });
  try {
    await evaluate();
    const resumed = await evaluate();
    assert.deepEqual(resumed.rows[0].execution, { taskId: tasks[0].id, tokens: 17 });
    assert.deepEqual(JSON.parse(await original(join(out, 'test.jsonl'), 'utf8')).execution.toolEvents, result.execution.toolEvents);
    await save(join(out, 'rows', `${digest(tasks[0].id)}.json`), { ...result, execution: { ...result.execution, toolEvents: [] } });
    await assert.rejects(evaluate, /Conflicting test result/);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); await rm(out, { recursive: true, force: true }); }
});

test('frozen evaluator I/O repair checks both modules and does not alter other entrypoints', async () => {
  const out = await mkdtemp(join(tmpdir(), 'mflow-io-repair-'));
  const original = join(out, 'dist/src/evaluation.js'), replacement = join(out, 'fixed.mjs'), receipt = join(out, 'receipt.json');
  const hash = (text: string) => createHash('sha256').update(text).digest('hex');
  try {
    await mkdir(join(out, 'dist/src'), { recursive: true });
    await fs.writeFile(original, 'export const value=1'); await fs.writeFile(replacement, 'export const value=2');
    await save(receipt, { original, replacement, originalSha256: hash('export const value=1'), replacementSha256: hash('export const value=2') });
    const run = (command: string) => execFileSync(process.execPath, ['--import', './scripts/evaluation_io_repair.mjs', '--input-type=module', '-e',
      `console.log((await import(${JSON.stringify(original)})).value)`, command], { env: { ...process.env, MFLOW_EVALUATION_IO_REPAIR: receipt }, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
    assert.equal(run('evaluate'), '2'); assert.equal(run('search'), '1');
    await fs.writeFile(replacement, 'export const value=3');
    assert.throws(() => run('evaluate'), /checksum mismatch/);
  } finally { await rm(out, { recursive: true, force: true }); }
});
