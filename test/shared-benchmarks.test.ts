import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchmarkPath, sharedPath } from '../src/benchmark-hub.js';
import { readTasks, assertDatasetRole, assertTestDisjoint } from '../src/data.js';
import { taskSchema, initialStrategy, limitsSchema } from '../src/types.js';
import { benchmarkSeed } from '../src/aflow-seed.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { grade, checkScoring, gradingIdentity } from '../src/grading.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('shared catalog resolves text views and fails closed for environment-only benchmarks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mflow-hub-'));
  const previous = process.env.BENCHMARK_HOME;
  process.env.BENCHMARK_HOME = dir;
  try {
    await writeFile(join(dir, 'catalog.json'), JSON.stringify({ benchmarks: {
      humaneval_plus: { defaultProtocol: 'p', views: { p: { path: 'text', format: 'mflow-jsonl' } } },
      gaia: { raw: 'gaia' },
    } }));
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(dir, 'text')); await writeFile(join(dir, 'text/test.jsonl'), 'fixture');
    assert.equal(await benchmarkPath('HumanEval+', 'test'), join(dir, 'text/test.jsonl'));
    await assert.rejects(benchmarkPath('GAIA', 'test'), /interactive adapter/);
    assert.throws(() => sharedPath(dir, '../outside'), /escapes/);
  } finally {
    if (previous === undefined) delete process.env.BENCHMARK_HOME; else process.env.BENCHMARK_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('HumanEval+ preserves locked split roles and cannot leak across the HumanEval family', () => {
  const task = taskSchema.parse({ id: 'humaneval_plus:HumanEval/1', prompt: 'def f():', answer: '',
    benchmark: 'humaneval_plus', metric: 'evalplus', dataset: { protocol: 'humaneval-plus-aflow-v1', split: 'test' },
    reference: { prefix: 'def f():', entryPoint: 'f', evalplusTaskId: 'HumanEval/1' } });
  assertDatasetRole([task], 'test');
  assert.throws(() => assertDatasetRole([task], 'search'));
  assert.throws(() => assertDatasetRole([task], 'prepare'));
  assert.throws(() => assertTestDisjoint([task], { selectionTaskIds: ['humaneval:HumanEval/1'],
    selectionGroups: [], selectionPromptHashes: [] }), /overlaps/);
  assert.throws(() => taskSchema.parse({ ...task, dataset: undefined }));
});

test('expanded-test metadata does not permit a modified or partial split', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mflow-plus-'));
  try {
    const file = join(dir, 'test.jsonl');
    await writeFile(file, JSON.stringify({ id: 'humaneval_plus:HumanEval/1', prompt: 'def f():', answer: '',
      benchmark: 'humaneval_plus', metric: 'evalplus', dataset: { protocol: 'humaneval-plus-aflow-v1', split: 'test' },
      reference: { prefix: 'def f():', entryPoint: 'f', evalplusTaskId: 'HumanEval/1' } }) + '\n');
    await assert.rejects(readTasks(file), /complete locked split/);
    assert.deepEqual(JSON.parse(await readFile('data/humaneval-plus.lock.json', 'utf8')),
      JSON.parse(await readFile('benchmark-hub/humaneval-plus.lock.json', 'utf8')));
    assert.equal(await readFile('data/aflow.lock.json', 'utf8'), await readFile('benchmark-hub/aflow.lock.json', 'utf8'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

for (const [benchmark, metric, prompt, answer] of [
  ['drop', 'drop', 'Passage: Alice owns a cat. Question: Who owns a cat?', 'Alice'],
  ['humaneval', 'python', 'Implement f(x), adding one.', 'def f(x):\n    # Literal \\boxed{example} must remain part of the code.\n    return x + 1'],
] as const) test(`${benchmark} search seed executes through Ditto with the correct answer contract`, async () => {
  const task = taskSchema.parse({ id: 'fixture', prompt, answer: 'HIDDEN_REFERENCE', benchmark, metric,
    reference: metric === 'python' ? { tests: ['SECRET_TEST'] } : { answers: [['HIDDEN_REFERENCE']] } });
  const seed = benchmarkSeed([task]);
  const calls: unknown[] = [];
  const organization = structuredClone(seed.organization);
  organization.agentTemplates!.find(t => t.id === 'independent')!.profile.tools = ['arithmetic'];
  const provider = new MeteredProvider({ async invoke(input) {
    calls.push(input); return { message: { role: 'assistant', content: answer }, finishReason: 'stop', usage: { totalTokens: 10 } };
  } });
  const agents = new DittoAgents(provider, { model: 'fixture', baseUrl: 'https://invalid.example', temperature: 0, seed: 42 });
  const result = await new OrganizationRuntime(agents, limitsSchema.parse({ maxTokens: 100000, maxSteps: 40 }))
    .run({ ...initialStrategy, composition: seed.composition, organization, prompts: seed.prompts }, { id: task.id, prompt: task.prompt });
  assert.equal(result.answer, answer); assert.equal(calls.length, 2);
  assert.ok(!JSON.stringify(calls).includes('HIDDEN_REFERENCE'));
  assert.ok(!JSON.stringify(calls).includes('SECRET_TEST'));
  assert.ok(!seed.prompts.agent.includes('math problem'));
  assert.equal(seed.dataset, benchmark === 'drop' ? 'DROP' : 'HumanEval');
});

test('HumanEval+ official checker scores both complete and incorrect Python inside Docker', async t => {
  let tasks;
  try { tasks = await readTasks('benchmark:humaneval+/test'); await checkScoring(tasks); }
  catch (error) { t.skip(`Local EvalPlus assets/image unavailable: ${String(error)}`); return; }
  const task = tasks.find(t => t.reference?.evalplusTaskId === 'HumanEval/0') ?? tasks[0];
  // Task 0 has a small, independently written implementation; this is a wiring check, not a model score.
  if (task.reference?.evalplusTaskId !== 'HumanEval/0') { t.skip('Task 0 not in this test split'); return; }
  const correct = 'from typing import List\ndef has_close_elements(numbers: List[float], threshold: float) -> bool:\n    return any(abs(a-b) < threshold for i,a in enumerate(numbers) for b in numbers[i+1:])\n';
  assert.equal((await grade(task, correct)).score, 1);
  assert.equal((await grade(task, 'def has_close_elements(numbers, threshold):\n    return False')).score, 0);
  const identity = await gradingIdentity(tasks);
  assert.match(identity.evalplusImage!, /^sha256:/);
});

test('DROP and MBPP CLI seeds run one tool-free Ditto agent without search or reference access', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mflow-single-text-'));
  try {
    for (const [benchmark, answer] of [['drop', 'Alice'], ['mbpp', 'def add(a, b):\n    return a + b']] as const) {
      const out = join(dir, `${benchmark}.json`);
      await promisify(execFile)(process.execPath, ['dist/src/cli.js', 'seed', '--benchmark', benchmark,
        '--initialization', 'single', '--out', out], { env: { ...process.env, MFLOW_API_KEY: '', MFLOW_MODEL: 'fixture' } });
      const bundle = JSON.parse(await readFile(out, 'utf8'));
      assert.deepEqual(bundle.selectionTaskIds, []);
      assert.equal(bundle.strategy.organization.toolCreation, false);
      assert.deepEqual(bundle.strategy.organization.initialAgents[0].tools, []);
      assert.match(bundle.strategy.prompts.agent, benchmark === 'mbpp' ? /complete executable Python/ : /supplied passage/);
      let calls = 0;
      const provider = new MeteredProvider({ async invoke(input) {
        calls++;
        assert.equal(input.actions?.length ?? 0, 0);
        assert.ok(!JSON.stringify(input).includes('HIDDEN_REFERENCE'));
        return { message: { role: 'assistant', content: answer }, finishReason: 'stop', usage: { totalTokens: 10 } };
      } });
      const result = await new OrganizationRuntime(new DittoAgents(provider, bundle.model), bundle.config.episode, bundle.pool)
        .run(bundle.strategy, { id: 'fixture', prompt: benchmark === 'mbpp' ? 'Implement add(a, b).' : 'Passage: Alice owns a cat. Question: Who owns a cat?' });
      assert.equal(calls, 1);
      assert.equal(result.agents.length, 1);
      assert.equal(result.answer, answer);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
