import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkpointExecution } from '../src/evaluation.js';
import { GradingFailure } from '../src/grading.js';
import type { Execution } from '../src/types.js';
import { grade, checkScoring } from '../src/grading.js';
import { taskSchema } from '../src/types.js';
import { execFileSync } from 'node:child_process';
import { dockerCommand } from '../src/python-tool.js';

test('Docker connection failure with exit 1 is infrastructure, not a wrong answer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mflow-docker-outage-'));
  const docker = join(dir, 'docker');
  try {
    await writeFile(docker, '#!/bin/sh\necho "Cannot connect to the Docker daemon" >&2\nexit 1\n', {mode:0o755});
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import {grade,GradingFailure} from ${JSON.stringify(new URL('../src/grading.js', import.meta.url).href)};
      await assert.rejects(grade({id:'fixture',metric:'python',reference:{tests:['assert solve() == 1']}}, 'def solve(): return 1'),GradingFailure);
    `], {env:{...process.env,MFLOW_DOCKER:docker}});
  } finally { await rm(dir,{recursive:true,force:true}); }
});

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

test('Python failure diagnostics are search-only and never change the score', async t => {
  const task = taskSchema.parse({id:'diagnostic-fixture',prompt:'Implement solve.',answer:'',metric:'python',
    benchmark:'mbpp',aflowSplit:'validate',reference:{tests:['assert solve() == 42']}});
  await assert.rejects(grade({...task,aflowSplit:'test'},'def solve(): return 0',undefined,undefined,'search'),/cannot be used for search/);
  try { await checkScoring([task]); } catch { t.skip('Docker Python required'); return; }
  const answer = 'def solve(): return 0';
  assert.deepEqual(await grade(task,answer),{score:0});
  const feedback=await grade(task,answer,undefined,undefined,'search');
  assert.equal(feedback.score,0);
  assert.match(feedback.gradingFeedback!,/AssertionError/);
  assert.match(feedback.gradingFeedback!,/assert solve\(\) == 42/);
  assert.deepEqual(await grade(task,'def solve(): return 42',undefined,undefined,'search'),{score:1});
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
