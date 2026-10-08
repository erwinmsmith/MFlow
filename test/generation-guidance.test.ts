import test from 'node:test';
import assert from 'node:assert/strict';
import { withGenerationGuidance, installGenerationGuidance, failedPythonProbes } from '../src/generation-guidance.js';

test('finite-program guidance preserves model settings, tools, input and response schema', () => {
  const body = {model:'fixture',temperature:0,max_tokens:393216,stream:true,
    response_format:{type:'json_object'},tools:[{type:'function',function:{name:'python',parameters:{type:'object'}}}],
    messages:[{role:'user',content:'SEARCH OBJECT: a complete dynamic MAS; fixture'}]};
  const signal = new AbortController().signal;
  const init = {body:JSON.stringify(body),signal,headers:{'x-fixture':'fixture'}};
  const updated = withGenerationGuidance(init)!;
  assert.equal(updated.signal,signal); assert.equal(updated.headers,init.headers);
  const result = JSON.parse(String(updated.body));
  assert.match(result.messages[0].content,/finite executable Python/);
  assert.match(result.messages[0].content,/no ctx.self/);
  result.messages.shift(); assert.deepEqual(result,body);
  assert.equal(withGenerationGuidance(updated),updated);
  for (const body of ['not JSON','null',JSON.stringify({messages:[{role:'user',content:'plain answer'}]})]) {
    const request={body};assert.equal(withGenerationGuidance(request),request);
  }
});

test('live installation leaves an in-flight request intact and changes only future requests', async () => {
  const original=globalThis.fetch;
  const key=Symbol.for('mflow.generation-guidance.finite-programs-v2');
  const globals=globalThis as typeof globalThis & {[key:symbol]:unknown};
  let finish!: (response:Response)=>void;
  const bodies:string[]=[];
  globalThis.fetch=async (_url,init)=>{bodies.push(String(init?.body));return new Promise(resolve=>{finish=resolve;});};
  try {
    const init={body:JSON.stringify({tools:[{function:{name:'python'}}],messages:[]})};
    const old=fetch('https://fixture.invalid',init);const oldFinish=finish;
    const state=installGenerationGuidance();assert.equal(installGenerationGuidance(),state);
    oldFinish(new Response('existing answer'));
    assert.equal(await (await old).text(),'existing answer');assert.equal(bodies[0],init.body);
    const next=fetch('https://fixture.invalid',init);finish(new Response('new answer'));await next;
    assert.match(bodies[1],/finite-programs-v2/);
    assert.equal((state as {modifiedRequests:number}).modifiedRequests,1);
  } finally {globalThis.fetch=original;delete globals[key];}
});


test('failed Python probe enumeration stops while changed implementations and successful sweeps remain allowed', () => {
  const history=(n:number,success=false,change=false)=>Array.from({length:n},(_,i)=>[
    {role:'assistant',tool_calls:[{id:String(i),function:{name:'python',arguments:JSON.stringify({code:`def f(n):\n    return ${change?i:1} + f(n//2)\nprint(f(${i+1}))\n`})}}]},
    {role:'tool',tool_call_id:String(i),content:success?'success': 'failed: PYTHON_EXECUTION: RecursionError'}]).flat();
  assert.equal(failedPythonProbes(history(20)),20);
  assert.equal(failedPythonProbes(history(20,true)),0);
  assert.equal(failedPythonProbes(history(20,false,true)),1);
  const body={tools:[{function:{name:'python'}}],messages:history(4)};
  assert.match(String(withGenerationGuidance({body:JSON.stringify(body)})?.body),/Changing only the probe input/);
  body.messages.unshift({role:'system',content:'[MFLOW finite-programs-v2] existing'} as any);
  assert.match(String(withGenerationGuidance({body:JSON.stringify(body)})?.body),/Changing only the probe input/);
  assert.throws(()=>withGenerationGuidance({body:JSON.stringify({...body,messages:history(5)})}),{code:'DEGENERATE_OUTPUT'});
});
