import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProvider, SampleInput } from '@codesoul-co/ditto/worker/infer';
import { MeteredProvider, DittoAgents, arithmeticTool } from '../src/ditto.js';
import { observableProvider, ProviderFailure, repeatedOutput, repeatedToolCycles } from '../src/provider-progress.js';
import { createPythonTool } from '../src/python-tool.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { aflowInspiredComposition, textOrganization, textPrompts } from '../src/aflow-seed.js';
import { initialStrategy, limitsSchema } from '../src/types.js';
import type { WorkerContext } from '@codesoul-co/ditto/worker';
import { createDitto, createInferWorker, createInteractionWorker, runReactFlow } from '@codesoul-co/ditto';

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

test('identical completed tool cycles get recovery guidance then fail without another paid call', async () => {
  const messages = (n: number, changing = false): SampleInput['messages'] => Array.from({length:n}, (_, i) => [
    {role:'assistant' as const,content:'',metadata:{actionRequests:[{id:String(i),name:'python',arguments:{code:`print(${changing ? i : 1})`}}]}},
    {role:'tool' as const,content:'1',metadata:{actionRequestId:String(i),name:'python'}},
  ]).flat();
  assert.equal(repeatedToolCycles(messages(20, true)), 1);
  let calls = 0;
  const provider = observableProvider({async invoke(request) {
    calls++; assert.match(String(request.messages.at(-1)!.content), /Execution diagnostic/);
    return response('1');
  }}, {});
  await provider.invoke({...input,messages:messages(4)}, {signal:AbortSignal.timeout(1000)});
  await assert.rejects(provider.invoke({...input,messages:messages(5)}, {signal:AbortSignal.timeout(1000)}), {code:'DEGENERATE_OUTPUT'});
  assert.equal(calls,1);
});

test('native Ditto tool loop stops unchanged Python despite different random counterexamples', async () => {
  let calls = 0, executions = 0, warned = false;
  const provider = observableProvider({async invoke(request) {
    calls++;
    warned ||= String(request.messages.at(-1)?.content).includes('Randomized tests');
    return {message:{role:'assistant',content:''},finishReason:'action_request',usage:{totalTokens:1},
      actionRequests:[{id:'call-'+calls,name:'python',arguments:{code:'unchanged synthetic random test'}}]};
  }}, {});
  const runtime = createDitto({sandbox:{tools:['python']},workers:[
    createInferWorker({providers:{fixture:provider}}),
    createInteractionWorker({tools:[{name:'python',description:'fixture',inputSchema:{type:'object'},validate(){},
      async execute(){return {status:'failed',content:`AssertionError: random counterexample ${++executions}`,
        error:{code:'PYTHON_EXECUTION',message:'Python exited 1'}};}}]}),
  ]});
  try {
    const result = await runReactFlow(runtime,{model:{provider:'fixture',model:'fixture'},messages:input.messages,
      actions:[{name:'python',description:'fixture',inputSchema:{type:'object'},target:{kind:'tool',toolName:'python'}}],
      constraints:{maxSteps:100,maxActionCalls:100,maxTotalTokens:10000,timeoutMs:5000}},{timeoutMs:5000});
    assert.equal(calls,5,JSON.stringify(result)); assert.equal(executions,5); assert.equal(warned,true);
    assert.notEqual(result.status,'completed');
    assert.match(JSON.stringify(result.error),/Unchanged tool computation/);
  } finally { await runtime.close(); }
});

test('computation guard allows corrected code and changing external state', () => {
  const history = (name: string, changed: boolean): SampleInput['messages'] => Array.from({length:20},(_,i)=>[
    {role:'assistant' as const,content:'',metadata:{actionRequests:[{id:String(i),name,arguments:{code:changed?String(i):'same'}}]}},
    {role:'tool' as const,content:`observation ${i}`,metadata:{actionRequestId:String(i),name}},
  ]).flat();
  assert.equal(repeatedToolCycles(history('python',false)),1);
  assert.equal(repeatedToolCycles(history('python',false),true),20);
  assert.equal(repeatedToolCycles(history('python',true),true),1);
  assert.equal(repeatedToolCycles(history('api_fetch',false),true),1);
});

test('sandbox command deadlines become failed observations but caller cancellation propagates', async () => {
  const tool = createPythonTool('fixture-image');
  const controller = new AbortController();
  const timeout = Object.assign(new Error('Command timed out'), { name: 'TimeoutError' });
  const context = { signal: controller.signal, services: { sandbox: { run: async () => { throw timeout; } } } } as unknown as WorkerContext<unknown, unknown>;
  const outcome = await tool.execute({ code: 'print(1)' }, context);
  assert.equal(outcome.status, 'failed'); assert.equal(outcome.error?.code, 'PYTHON_TIMEOUT');
  controller.abort();
  await assert.rejects(tool.execute({ code: 'print(1)' }, context), /Command timed out/);
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

test('tool argument cycles are observed independently without treating reasoning as answer text', async () => {
  const progress: import('../src/provider-progress.js').ProviderProgress[] = [];
  const transport=observableProvider({ async invoke(){throw new Error('stream required');}, async *stream(){
    yield {type:'reasoning_delta' as const,delta:'private fixture reasoning'};
    yield {type:'action_delta' as const,index:0,name:'python',delta:'print(1)\n'.repeat(3000)};
  } },{stream:true,onProgress:async p=>{progress.push(p);}});
  await assert.rejects(transport.invoke(input,{signal:AbortSignal.timeout(1000)}),{code:'DEGENERATE_OUTPUT'});
  assert.equal(progress.at(-1)?.textChars,0);
  assert.ok(progress.at(-1)!.actionChars!>0);assert.ok(progress.at(-1)!.lastGenerationAt);
  assert.ok(!JSON.stringify(progress).includes('private fixture reasoning'));
});

test('invalid web arguments become a correctable tool observation', async () => {
  const {createBenchmarkWebTool}=await import('../src/python-tool.js');
  const tool=createBenchmarkWebTool();
  const result=await tool.execute({query:'too many words '.repeat(100)},{} as WorkerContext<unknown,unknown>);
  assert.equal(result.status,'failed');assert.equal(result.error?.code,'WEB_SEARCH_ARGUMENTS');
});


test('HTTP gateway failures retry the current model turn instead of losing the task world', async () => {
 for(const failure of [new ProviderFailure('PROVIDER_HTTP_ERROR','HTTP 502: Bad Gateway'),new ProviderFailure('PROVIDER_FAILURE','fetch failed')]){
  let attempts=0;
  const meter=new MeteredProvider({async invoke(){if(++attempts===1)throw failure;return response('5');}});
  assert.equal((await meter.invoke(input,{signal:AbortSignal.timeout(5000)})).finishReason,'stop');
  assert.equal(attempts,2);assert.deepEqual(meter.records.map(r=>r.status),['unknown','known']);assert.equal(meter.lastFailure,undefined);
 }
});
