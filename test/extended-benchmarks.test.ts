import test from 'node:test';
import assert from 'node:assert/strict';
import { readTasks, assertDisjoint, assertDatasetRole } from '../src/data.js';
import { taskSchema, initialStrategy, limitsSchema } from '../src/types.js';
import { benchmarkSeed } from '../src/aflow-seed.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { executeBenchmark, openAutomation } from '../src/benchmark-environment.js';
import { grade } from '../src/grading.js';
import { benchmarkPath } from '../src/benchmark-hub.js';

const model = { model: 'fixture', baseUrl: 'https://invalid.example', temperature: 0, seed: 42 };

test('HLE remains test-only and grading references enter only the Ditto judge', async () => {
  const task = taskSchema.parse({ id: 'hle:fixture', prompt: 'An academic question', answer: 'GRADER_ONLY_REFERENCE',
    metric: 'hle', benchmark: 'hle', dataset: { protocol: 'hle-text-test-v1', split: 'test' } });
  assert.throws(() => assertDatasetRole([task], 'search'));
  assert.throws(() => assertDatasetRole([task], 'prepare'));
  assert.throws(() => taskSchema.parse({ ...task, dataset: { ...task.dataset, split: 'search' } }));
  const seed = benchmarkSeed([task]), calls: string[] = [];
  const provider = new MeteredProvider({ async invoke(input) {
    const text = JSON.stringify(input); calls.push(text);
    const judging = input.metadata?.kind === 'hle-judge';
    return { message: { role: 'assistant', content: judging ? JSON.stringify({
      extracted_final_answer: 'candidate', reasoning: 'Fixture judgement', correct: 'no', confidence: 60, strict: true,
    }) : 'Explanation: fixture\nAnswer: candidate\nConfidence: 60%' }, finishReason: 'stop', usage: {totalTokens: 10} };
  } });
  const agents = new DittoAgents(provider, model);
  const execution = await executeBenchmark(task, agents, { ...initialStrategy, ...seed }, limitsSchema.parse({maxTokens: 100000}));
  assert.ok(calls.every(c => !c.includes(task.answer)));
  const previous = process.env.MFLOW_HLE_JUDGE_MODEL;
  process.env.MFLOW_HLE_JUDGE_MODEL = 'fixture-judge';
  try {
    const result = await grade(task, execution.answer, execution, agents);
    assert.equal(result.score, 0); assert.equal(result.confidence, 60);
    assert.ok(calls.at(-1)!.includes(task.answer)); assert.ok(calls.at(-1)!.includes('fixture-judge'));
    assert.equal(provider.tokens, 30);
  } finally { if (previous === undefined) delete process.env.MFLOW_HLE_JUDGE_MODEL; else process.env.MFLOW_HLE_JUDGE_MODEL = previous; }
});

test('official shared views are locked, disjoint, and HLE has no search view', async t => {
  let search, heldout, hle;
  try { search = await readTasks('benchmark:automationbench/search'); heldout = await readTasks('benchmark:automationbench/test'); hle = await readTasks('benchmark:hle/test'); }
  catch (e) { t.skip(`Local assets unavailable: ${String(e)}`); return; }
  assert.equal(search.length, 200); assert.equal(heldout.length, 600); assert.equal(hle.length, 2158);
  assertDisjoint(search, heldout);
  await assert.rejects(benchmarkPath('hle', 'search'), /no search split/);
});

test('Ditto registered API tools mutate one official world, whose saved checkpoint can be regraded', async t => {
  let tasks;
  try { tasks = await readTasks('benchmark:automationbench/search'); }
  catch (e) { t.skip(`Local official assets unavailable: ${String(e)}`); return; }
  const task = tasks.find(t => t.reference?.automationTaskId === 'simple.email_sf_contact_phone_update')!;
  const seed = benchmarkSeed([task]); let n = 0;
  const calls: string[] = [];
  const provider = new MeteredProvider({ async invoke(input) {
    calls.push(JSON.stringify(input)); n++;
    const action = n === 1 ? { id: 'discover', name: 'api_search', arguments: {query: 'salesforce contacts update', top_k: 1} }
      : n === 2 ? { id: 'update', name: 'api_fetch', arguments: {method: 'PATCH',
        url: 'https://yourinstance.salesforce.com/services/data/v61.0/sobjects/Contact/003001', params: null,
        body: JSON.stringify({Phone: '+1-555-0101'})} } : undefined;
    return { message: {role: 'assistant', content: action ? '' : 'Updated the contact.'}, finishReason: action ? 'action_request' : 'stop',
      ...(action ? {actionRequests: [action]} : {}), usage: {totalTokens: 10} };
  } });
  const execution = await executeBenchmark(task, new DittoAgents(provider, model), { ...initialStrategy, ...seed }, limitsSchema.parse({maxTokens: 100000, maxToolCalls: 10}));
  assert.ok(execution.toolEvents.length >= 2);
  assert.ok(calls.every(c => !c.includes('initial_state') && !c.includes('assertions')));
  const restored = JSON.parse(JSON.stringify(execution));
  const result = await grade(task, execution.answer, restored);
  assert.equal(result.score, 1); assert.equal(result.partialCredit, 1);
  await assert.rejects(grade(task, 'I completed it'), /saved world checkpoint/);
  const fresh = await openAutomation(task);
  try {
    const snapshot = await fresh.request<{contract: string; world: unknown}>({op: 'snapshot'});
    const untouched = await fresh.request<{score: number}>({op: 'grade', ...snapshot});
    assert.equal(untouched.score, 0);
  } finally { fresh.close(); }
});
