import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateConcurrent } from '../src/evaluation.js';
import { save, digest } from '../src/util.js';
import { taskSchema, type Evaluated, type Task, type Execution } from '../src/types.js';

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
