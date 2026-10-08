import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointExecution } from '../src/evaluation.js';
import { GradingFailure } from '../src/grading.js';
import type { Execution } from '../src/types.js';
import { grade, checkScoring } from '../src/grading.js';
import { taskSchema } from '../src/types.js';
import { execFileSync } from 'node:child_process';
import { dockerCommand } from '../src/python-tool.js';

test('nonterminating candidate code scores zero and leaves no grading container', async t => {
  const task = taskSchema.parse({id:'timeout-fixture',prompt:'fixture',answer:'',metric:'python',
    reference:{tests:['assert solve() == 1']}});
  try { await checkScoring([task]); } catch { t.skip('Docker Python required'); return; }
  const containers = () => execFileSync(dockerCommand, ['ps','-aq','--filter','label=mflow.grading-task=timeout-fixture'], {encoding:'utf8'}).trim();
  const before = containers();
  const started = Date.now();
  assert.deepEqual(await grade(task, 'def solve():\n    while True: pass'), {score:0});
  assert.ok(Date.now()-started < 60000);
  assert.equal(containers(), before);
});

test('grading failure and recovery reuse exactly the committed model answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mflow-grade-recovery-'));
  let modelCalls = 0;
  const execute = async () => { modelCalls++; return { taskId: 'fixture', answer: 'original-answer' } as Execution; };
  const path = join(dir, 'executions', 'fixture.json');
  try {
    await assert.rejects(async () => {
      const execution = await checkpointExecution(path, 'fixture', execute);
      assert.equal(execution.answer, 'original-answer');
      throw new GradingFailure({ signal: 'SIGTERM', killed: true });
    }, GradingFailure);
    const resumed = await checkpointExecution(path, 'fixture', execute);
    assert.equal(resumed.answer, 'original-answer'); assert.equal(modelCalls, 1);
    await assert.rejects(checkpointExecution(path, 'different-task', execute), /Invalid execution checkpoint/);
    assert.equal(modelCalls, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
