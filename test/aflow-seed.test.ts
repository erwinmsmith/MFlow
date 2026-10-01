import test from 'node:test';
import assert from 'node:assert/strict';
import type { ModelProvider, SampleInput } from '@codesoul-co/ditto/worker/infer';
import { aflowInspiredComposition, textOrganization, textPrompts } from '../src/aflow-seed.js';
import { boxedAnswer } from '../src/composition.js';
import { DittoAgents, MeteredProvider } from '../src/ditto.js';
import { OrganizationRuntime } from '../src/runtime.js';
import { ProviderFailure } from '../src/provider-progress.js';
import { initialStrategy, limitsSchema } from '../src/types.js';

const organization = () => {
  const value = structuredClone(textOrganization);
  value.agentTemplates!.find(t => t.id === 'independent')!.profile.tools = ['arithmetic'];
  return value;
};
const execute = (provider: ModelProvider) => new OrganizationRuntime(new DittoAgents(new MeteredProvider(provider),
  {model:'fixture',baseUrl:'https://invalid.example',temperature:0,seed:42}),limitsSchema.parse({maxSteps:40,maxTokens:100000}))
  .run({...initialStrategy, composition:aflowInspiredComposition,organization:organization(),prompts:textPrompts},
    {...{id:'synthetic',prompt:'Calculate 2 plus 3.',answer:'HIDDEN-LABEL'}});
const response = (answer: string) => ({message:{role:'assistant' as const,content:`Full derivation: 2 + 3 = ${answer}. Final: \\boxed{${answer}}`},finishReason:'stop' as const,usage:{totalTokens:20}});

test('balanced boxed extraction preserves nested fractions and rejects truncated boxes',()=>{
  assert.equal(boxedAnswer(String.raw`first \boxed{1} then \boxed{\frac{2}{3}}.`),String.raw`\boxed{\frac{2}{3}}`);
  assert.equal(boxedAnswer(String.raw`partial \boxed{\frac{2}{3}`),undefined);
  assert.equal(boxedAnswer('5'),undefined);
});

test('text seed routes the complete proof, per-agent capabilities and text response format through Ditto',async()=>{
  const calls:SampleInput[]=[];
  const result=await execute({async invoke(input){calls.push(input);return response('5');}});
  assert.equal(result.answer,String.raw`\boxed{5}`);assert.equal(calls.length,2);
  assert.ok(calls.every(i=>i.model.providerOptions?.response_format && (i.model.providerOptions.response_format as any).type==='text'));
  assert.match(String(calls[1].messages[0].content),/Full derivation: 2 \+ 3 = 5/);
  assert.match(String(calls[1].messages[0].content),/Mathematical review and revision/);
  assert.ok(!JSON.stringify(calls).includes('HIDDEN-LABEL'));
  assert.equal(result.outputs[0].output.artifacts[0].content,response('5').message.content);
  assert.equal(result.actualTokens,40);
});

test('disagreement dynamically derives a different graph with executable tools and an independent context',async()=>{
  let n=0;
  const result=await execute({async invoke(input){
    n++;
    if(n===1)return response('4');
    if(n===2)return response('5');
    if(n===3){
      assert.ok(!JSON.stringify(input.messages).includes('Full derivation'));
      assert.ok(input.actions?.some(a=>a.name==='arithmetic'));
      return {message:{role:'assistant',content:''},finishReason:'action_request',actionRequests:[{id:'sum',name:'arithmetic',arguments:{operation:'add',values:[2,3]}}],usage:{totalTokens:10}};
    }
    assert.equal(input.messages.at(-1)?.metadata?.actionRequestId,'sum');
    return response('5');
  }});
  assert.equal(result.answer,String.raw`\boxed{5}`);assert.equal(n,4);
  assert.equal(result.agents.length,3);assert.equal(result.toolEvents.length,1);
  assert.notDeepEqual(result.agents[1].nodes,result.agents[2].nodes);
});

for(const fault of ['DEGENERATE_OUTPUT','INVALID_MODEL_OUTPUT','INCOMPLETE_MODEL_OUTPUT','MODEL_CONTEXT_LIMIT','length']){
  test(`${fault} stays local to the failed agent without rerunning the original solve`,async()=>{
    const calls:string[]=[];
    const result=await execute({async invoke(input){
      calls.push(String(input.metadata?.agentId));
      if(input.metadata?.agentId==='reviewer'){
        if(fault==='length')return {...response('WRONG-PARTIAL'),finishReason:'length'};
        throw new ProviderFailure(fault,'fixture node fault');
      }
      return response('5');
    }});
    assert.equal(result.answer,String.raw`\boxed{5}`);
    assert.deepEqual(calls,['root','reviewer','independent']);
    assert.equal(result.outputs[1].output.candidate_answer,'');
    assert.ok(result.outputs[1].output.open_deficits.length);
    assert.equal(result.actualTokens,fault==='length'?60:null);
  });
}

test('infrastructure faults still abort, even after successful model work',async()=>{
  let calls=0;
  await assert.rejects(execute({async invoke(){if(++calls===1)return response('5');throw new ProviderFailure('HTTP_402','fixture unavailable');}}),/HTTP_402/);
  assert.equal(calls,2);
});

test('concurrent successful sibling cannot clear a fatal provider failure',async()=>{
  const meter=new MeteredProvider({async invoke(input){
    if(input.metadata?.nodeId==='bad')throw new ProviderFailure('HTTP_402','fixture');
    await new Promise(r=>setTimeout(r,5));return response('5');
  }});
  meter.beginEpisode(100000,{runId:'fixture'});
  await Promise.allSettled(['bad','ok'].map(nodeId=>meter.invoke({model:{model:'fixture'},messages:[{role:'user',content:'fixture'}],metadata:{nodeId}},{signal:AbortSignal.timeout(1000)})));
  assert.equal(meter.lastFailure?.code,'HTTP_402');
});

test('Python stderr reaches the tool observation without violating the interaction error contract',async(t)=>{
  const {createPythonTool,pythonImage}=await import('../src/python-tool.js');
  const {arithmeticTool}=await import('../src/ditto.js');
  let image:string;
  try{image=await pythonImage();}catch{t.skip('Docker Python image unavailable');return;}
  let calls=0;
  const provider:ModelProvider={async invoke(input){
    calls++;
    if(calls===1)return response('4');
    if(calls===2)return response('5');
    if(calls===3)return {message:{role:'assistant',content:''},finishReason:'action_request',actionRequests:[{id:'py-failed',name:'python',arguments:{code:"raise ValueError('fixture calculation error')"}}],usage:{totalTokens:10}};
    assert.equal(typeof input.messages.at(-1)?.content,'string');
    assert.ok(JSON.stringify(input.messages).includes('ValueError'));
    assert.ok(JSON.stringify(input.messages).includes('PYTHON_EXECUTION'));
    assert.equal(input.messages.at(-1)?.metadata?.actionRequestId,'py-failed');
    return response('5');
  }};
  const runtime=new OrganizationRuntime(new DittoAgents(new MeteredProvider(provider),{model:'fixture',baseUrl:'https://invalid.example',temperature:0,seed:42},[arithmeticTool,createPythonTool(image)]),limitsSchema.parse({maxSteps:40,maxTokens:100000}));
  const result=await runtime.run({...initialStrategy,composition:aflowInspiredComposition,organization:textOrganization,prompts:textPrompts},{id:'fixture',prompt:'Calculate 2 plus 3.'});
  assert.equal(calls,4);assert.equal(result.answer,String.raw`\boxed{5}`);
  assert.equal(result.toolEvents.length,1);
});
