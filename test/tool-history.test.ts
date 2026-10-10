import test from 'node:test';
import assert from 'node:assert/strict';
import type { SampleInput } from '@codesoul-co/ditto/worker/infer';
import { assertCompleteToolHistory } from '../src/tool-history.js';
import { MeteredProvider } from '../src/ditto.js';
import { ProviderFailure } from '../src/provider-progress.js';

const calls: SampleInput['messages'][number] = {role:'assistant',content:'',metadata:{actionRequests:[
  {id:'a',name:'write',arguments:{}},{id:'b',name:'read',arguments:{}}
]}};
const observation = (id:string): SampleInput['messages'][number] => ({role:'tool',content:'actual observation',metadata:{actionRequestId:id}});
const actions: SampleInput['actions'] = [{name:'read',description:'Read state',inputSchema:{type:'object'},target:{kind:'tool',toolName:'read'}}];
test('history accepts complete parallel results, rejects dangling and mismatched calls without fabricating observations',()=>{
  const valid=[{role:'user' as const,content:'task'},calls,observation('b'),observation('a')];
  const before=JSON.stringify(valid);assertCompleteToolHistory(valid);assert.equal(JSON.stringify(valid),before);
  for(const invalid of [[calls],[calls,observation('a')],[calls,{role:'user' as const,content:'clarify'}],
    [observation('a')],[calls,observation('x')],[calls,observation('a'),observation('a')]])
    assert.throws(()=>assertCompleteToolHistory(invalid),/missing observations|no matching/);
});
test('invalid JSON retries only inference and meters every attempt, preserving prior tool effects',async()=>{
  let callsMade=0;
  const messages=[calls,observation('a'),observation('b')];
  const meter=new MeteredProvider({async invoke(input){
    assert.deepEqual(input.messages.slice(0,3),messages);
    if(++callsMade===1)throw new ProviderFailure('INVALID_MODEL_OUTPUT','Malformed argument JSON');
    assert.match(String(input.messages.at(-1)!.content),/No actions from that response were executed/);
    return {message:{role:'assistant',content:'done'},finishReason:'stop',usage:{totalTokens:20}};
  }});
  await meter.invoke({model:{model:'fixture'},messages,actions,metadata:{kind:'agent',nodeId:'root/sample'}},{signal:AbortSignal.timeout(1000)});
  assert.equal(callsMade,2);assert.equal(meter.records.length,2);
  assert.equal(meter.records[0].status,'unknown');assert.equal(meter.records[1].charged,20);
  assert.equal(meter.nodeFailures.size,0);
});
test('JSON retries are bounded and billing failures are never retried by format recovery',async()=>{
  for(const code of ['INVALID_MODEL_OUTPUT','PROVIDER_HTTP_ERROR']) {
    let callsMade=0;
    const meter=new MeteredProvider({async invoke(){callsMade++;throw new ProviderFailure(code,code==='PROVIDER_HTTP_ERROR'?'HTTP 402: Insufficient Balance':'Invalid JSON');}});
    await assert.rejects(meter.invoke({model:{model:'fixture'},messages:[],actions,metadata:{kind:'agent'}},{signal:AbortSignal.timeout(1000)}),{code});
    assert.equal(callsMade,code==='INVALID_MODEL_OUTPUT'?3:1);assert.equal(meter.records.length,callsMade);
  }
});
