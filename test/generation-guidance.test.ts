import test from 'node:test';
import assert from 'node:assert/strict';
import { withGenerationGuidance, installGenerationGuidance } from '../src/generation-guidance.js';

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
  const key=Symbol.for('mflow.generation-guidance');
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
    assert.match(bodies[1],/finite-programs-v1/);
    assert.equal((state as {modifiedRequests:number}).modifiedRequests,1);
  } finally {globalThis.fetch=original;delete globals[key];}
});
