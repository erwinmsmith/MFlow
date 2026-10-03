import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { save, append, compactExecution, digest } from '../src/util.js';
import { execFileSync } from 'node:child_process';
import { organizationEvidence } from '../src/organization.js';
import type { Execution } from '../src/types.js';

test('compact disk evidence preserves scoring and organization feedback without changing live graphs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mflow-retention-'));
  const execution = { taskId: 'task', answer: 'answer', trace: [], agents: [], edges: [], outputs: [], toolEvents: [],
    environment: { contract: 'fixture', world: { result: 42 } }, tokens: 7,
    orchestration: { lifecycle: [], programs: [], graphs: [{ id: 'g', nodes: [{ id: 'a/n', type: 'SAMPLE', dependencies: [] }],
      inputs: { context: 'large input' }, outputs: { 'a/n': { status: 'failed', error: { code: 'fixture' }, messages: ['large output'] } } }] },
  } as unknown as Execution;
  try {
    const compact = compactExecution(execution);
    assert.deepEqual(organizationEvidence(compact), organizationEvidence(execution));
    assert.deepEqual(compact.environment, execution.environment);
    assert.deepEqual(compactExecution(compact), compact);
    await save(join(root, 'execution.json'), execution);
    await append(join(root, 'test.jsonl'), { score: 0, execution });
    assert.deepEqual(JSON.parse(await readFile(join(root, 'execution.json'), 'utf8')), compact);
    assert.deepEqual(JSON.parse(await readFile(join(root, 'test.jsonl'), 'utf8')).execution, compact);
    assert.equal(execution.orchestration!.graphs[0].inputs.context, 'large input');
    const progress = join(root, 'requests', 'one.json');
    await save(progress, { state: 'streaming' }); await save(progress, { state: 'completed' });
    await assert.rejects(readFile(progress), { code: 'ENOENT' });
    const run = join(root, 'runs', 'fixture'), evaluation = join(run, 'MFlow/round-tests/round-1');
    const row = { taskId: execution.taskId, score: 0, execution };
    await save(join(run, 'experiment-manifest.json'), {});
    const rowPath = join(evaluation, 'rows', digest(row.taskId) + '.json');
    await save(rowPath, row);
    // Recreate an old verbose checkpoint and an interrupted final aggregate append.
    await writeFile(rowPath, JSON.stringify(row));
    await writeFile(join(evaluation, 'test.jsonl'), JSON.stringify(row).slice(0, -10));
    execFileSync(process.execPath, ['scripts/compact_experiments.mjs', run, '--offline']);
    assert.deepEqual(JSON.parse(await readFile(join(evaluation, 'test.jsonl'), 'utf8')), { ...row, execution: compact });
    await assert.rejects(readFile(rowPath), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('parallel checkpoint saves preserve invocation order, snapshot values, and recover after write errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mflow-save-')), path = join(root, 'usage.json');
  try {
    const records: number[] = [], writes = [];
    for (let n = 0; n < 100; n++) {
      records.push(n); writes.push(save(n % 2 ? relative(process.cwd(), path) : path, records));
    }
    records.push(100);
    await Promise.all(writes);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), records.slice(0, 100));
    const blocked = join(root, 'blocked'); await writeFile(blocked, 'not a directory');
    await assert.rejects(save(join(blocked, 'usage.json'), {}));
    await rm(blocked); await save(join(blocked, 'usage.json'), { recovered: true });
    assert.deepEqual(JSON.parse(await readFile(join(blocked, 'usage.json'), 'utf8')), { recovered: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});
