import test from 'node:test';
import assert from 'node:assert/strict';
import { withOptimizerOutputBudget } from '../src/optimizer-context.js';

const overflow = new Error('[MODEL_CONTEXT_LIMIT] HTTP 400: This model\'s maximum context length is 1048576 tokens. However, you requested 1110568 tokens (717352 in the messages, 393216 in the completion). Please reduce the length of the messages or completion.');
test('optimizer retains evidence and fits output to the exact reported context remainder once', async () => {
  const calls: number[] = [], changes: unknown[] = [];
  const evidence = { parent: 'full unchanged parent graph', history: ['all search evidence'] };
  const result = await withOptimizerOutputBudget(393216, async maxTokens => {
    calls.push(maxTokens);
    if (calls.length === 1) throw overflow;
    return { evidence, maxTokens };
  }, async change => { changes.push(change); });
  assert.strictEqual(result.evidence, evidence);
  assert.deepEqual(calls, [393216, 331224]);
  assert.deepEqual(changes, [{ requested:393216,adjusted:331224,contextTokens:1048576,inputTokens:717352 }]);
});
test('optimizer never retries billing, unparseable limits, oversized input, or a failed correction', async () => {
  for (const error of [new Error('HTTP 402: Insufficient Balance'),new Error('[MODEL_CONTEXT_LIMIT] context exceeded'),
    new Error('[MODEL_CONTEXT_LIMIT] maximum context length is 100 tokens (101 in the messages, 393216 in the completion)')]) {
    let calls=0;
    await assert.rejects(withOptimizerOutputBudget(393216,async()=>{calls++;throw error;}),e=>e===error);
    assert.equal(calls,1);
  }
  let calls=0;
  await assert.rejects(withOptimizerOutputBudget(393216,async()=>{calls++;throw overflow;}),e=>e===overflow);
  assert.equal(calls,2);
});
