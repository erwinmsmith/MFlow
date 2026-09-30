import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProvider, SampleInput } from '@codesoul-co/ditto/worker/infer';
import { MeteredProvider, DittoAgents, arithmeticTool } from '../src/ditto.js';
import { observableProvider, ProviderFailure, repeatedOutput } from '../src/provider-progress.js';
import { createPythonTool } from '../src/python-tool.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { aflowInspiredComposition, textOrganization, textPrompts } from '../src/aflow-seed.js';
import { initialStrategy, limitsSchema } from '../src/types.js';

const input: SampleInput = { model: { model: 'fixture' }, messages: [{ role: 'user', content: 'synthetic task' }], metadata: { nodeId: 'root/sample' } };
const response = (answer: string) => ({ message: { role: 'assistant' as const, content: `Synthetic derivation. \\boxed{${answer}}` },
  finishReason: 'stop' as const, usage: { totalTokens: 20 } });

test('malformed Python arguments return a native observation and let the same agent finish', async () => {
  let calls = 0;
  const provider: ModelProvider = { async invoke(request) {
    calls++;
    assert.ok(!JSON.stringify(request.messages).includes('HIDDEN_LABEL'));
    if (calls === 1) return response('4');
    if (calls === 2) return response('5');
    if (calls === 3) return { message: { role: 'assistant', content: '' }, finishReason: 'action_request',
      actionRequests: [{ id: 'missing-code', name: 'python', arguments: {} }], usage: { totalTokens: 20 } };
    assert.equal(request.messages.at(-1)?.metadata?.actionRequestId, 'missing-code');
    assert.ok(JSON.stringify(request.messages).includes('PYTHON_ARGUMENTS'));
    return response('5');
  } };
  const execution = await new OrganizationRuntime(new DittoAgents(new MeteredProvider(provider),
    { model: 'fixture', baseUrl: 'https://invalid.example', temperature: 0, seed: 42 }, [arithmeticTool, createPythonTool('unused-image')]),
    limitsSchema.parse({ maxSteps: 40, maxTokens: 100000 })).run({ ...initialStrategy, composition: aflowInspiredComposition,
      organization: textOrganization, prompts: textPrompts }, { id: 'fixture', prompt: 'Synthetic addition task.' });
  assert.equal(execution.answer, String.raw`\boxed{5}`);
  assert.equal(calls, 4); assert.equal(execution.toolEvents.length, 1);
});

test('larger exact cycles are found even when an internal phrase is the nearest anchor', () => {
  const anchor = 'Repeated synthetic phrase, '.repeat(8).slice(0,128);
  const cycle = anchor + 'a'.repeat(3000) + anchor + 'b'.repeat(700) + anchor;
  assert.ok(cycle.length > 2048);
  assert.equal(repeatedOutput(cycle.repeat(10)), true);
  assert.equal(repeatedOutput(Array.from({length:6000},(_,i)=>`Distinct synthetic row ${i}: ${i*37}\n`).join('')), false);
});

test('partial socket failure retries the identical request with separate unknown and known cost', async () => {
  let attempts = 0;
  const seen: SampleInput[] = [];
  const transport = observableProvider({
    async invoke() { throw new Error('must use published stream'); },
    async *stream(request) {
      attempts++; seen.push(structuredClone(request));
      if (attempts === 1) {
        yield { type: 'text_delta' as const, delta: 'incomplete fixture text' };
        throw Object.assign(new Error('socket reset'), { code: 'UND_ERR_SOCKET' });
      }
      yield { type: 'result' as const, output: response('5') };
    },
  }, { stream: true });
  const meter = new MeteredProvider(transport);
  const result = await meter.invoke(input, { signal: AbortSignal.timeout(5000) });
  assert.equal(result.message.content, response('5').message.content);
  assert.equal(attempts, 2); assert.deepEqual(seen[0], seen[1]);
  assert.equal(meter.records.length, 2);
  assert.equal(meter.records[0].status, 'unknown'); assert.equal(meter.records[1].status, 'known');
  assert.equal(meter.lastFailure, undefined); assert.equal(meter.nodeFailures.size, 0);
});

test('auth failures and user cancellation do not trigger paid transport retries', async () => {
  let attempts = 0;
  const meter = new MeteredProvider({ async invoke() { attempts++; throw new ProviderFailure('HTTP_402', 'fixture auth failure'); } });
  await assert.rejects(meter.invoke(input, { signal: AbortSignal.timeout(5000) }), /HTTP_402/);
  assert.equal(attempts, 1); assert.equal(meter.lastFailure?.code, 'HTTP_402');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(meter.invoke(input, { signal: controller.signal }));
  assert.equal(attempts, 1);
});
