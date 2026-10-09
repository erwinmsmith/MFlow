import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

test('BFCL FC messages preserve call IDs and argument types', async () => {
  const modulePath = resolve('scripts/bfcl_single.mjs');
  const { bfclResponse, dittoMessages } = await import(modulePath);
  const output = {message:{role:'assistant',content:''},actionRequests:[{id:'call-1',name:'tool',arguments:{enabled:false,n:2,items:['a']}}],usage:{inputTokens:7,outputTokens:3}};
  const response = bfclResponse(output);
  const [message, tool] = dittoMessages([response.model_responses_message_for_chat_history,{role:'tool',content:'ok',tool_call_id:'call-1'}]);
  assert.deepEqual(message.metadata.actionRequests,output.actionRequests);
  assert.equal(tool.metadata.actionRequestId,'call-1');
  assert.equal(response.input_token,7);
});

test('BFCL native controller uses Ditto tools and resumes without repeating paid samples', async t => {
  const python = resolve('../Benchmarks/environments/bfcl/bin/python');
  try {await access(python);} catch {t.skip('Official BFCL environment required');return;}
  await promisify(execFile)(process.execPath,['--input-type=module','-e',`
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {runTask} from './scripts/bfcl_single.mjs';
const run=mkdtempSync(resolve(tmpdir(),'bfcl-fixture-'));
for(const d of ['results','responses','checkpoints'])mkdirSync(resolve(run,d));
const common={run,python:${JSON.stringify(python)},official:resolve('../Benchmarks/collections/official-20260930/BFCL/official/berkeley-function-call-leaderboard'),taskId:'multi_turn_base_0',config:{model:'fixture',temperature:0,maxOutputTokens:1000,timeoutMs:30000}};
let calls=0,observed;
const provider={async invoke(input){calls++;if(calls===1)return {message:{role:'assistant',content:''},actionRequests:[{id:'cd-1',name:'cd',arguments:{folder:'document'}}],finishReason:'action_request',usage:{inputTokens:10,outputTokens:5,totalTokens:15}};observed=input.messages;throw new Error('fixture outage');}};
try{
await assert.rejects(runTask({...common,provider}),/fixture outage/);
assert(observed.some(m=>m.role==='tool'&&m.metadata.actionRequestId==='cd-1'));
let resumed=0;
const result=await runTask({...common,provider:{async invoke(input){if(!resumed)assert.deepEqual(input.messages,observed);resumed++;return {message:{role:'assistant',content:'Done'},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}}});
assert.equal(result.id,'multi_turn_base_0');assert.equal(result.score,0);
assert.equal(calls,2);assert(resumed>0);
const rows=JSON.parse(readFileSync(resolve(run,'responses/multi_turn_base_0.json')));
assert.equal(rows.result[0][0][0].cd,'{"folder":"document"}');
const available=[];
await runTask({...common,taskId:'multi_turn_miss_func_0',provider:{async invoke(input){available.push(input.actions.map(t=>t.name));return {message:{role:'assistant',content:'Cannot proceed'},finishReason:'stop',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}}});
assert(available.some(names=>names.length>available[0].length),'Official holdout functions must be added only in later turns');
let rejectedCalls=0;
const rejected=await runTask({...common,taskId:'multi_turn_base_1',provider:{async invoke(){rejectedCalls++;return {message:{role:'assistant',content:''},actionRequests:[{id:'invalid',name:'not_an_exposed_tool',arguments:{}}],finishReason:'action_request',usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}}});
assert.equal(rejected.score,0);assert.equal(rejected.errorType,'unavailable_tool');assert.equal(rejectedCalls,1);
assert.equal(JSON.parse(readFileSync(resolve(run,'responses/multi_turn_base_1.json'))).rejectedResponse.actionRequests[0].name,'not_an_exposed_tool');
}finally{rmSync(run,{recursive:true,force:true});}
`],{timeout:60000,maxBuffer:2*1024*1024});
});

test('BFCL shared MAS world guards turns, withholds future docs and replays official grading', async t => {
  const python = resolve('../Benchmarks/environments/bfcl/bin/python');
  try {await access(python);} catch {t.skip('Official BFCL environment required');return;}
  const { readTasks, actorInput, assertDisjoint } = await import('../src/data.js');
  const { benchmarkPath } = await import('../src/benchmark-hub.js');
  const { openBFCL } = await import('../src/bfcl-environment.js');
  const { benchmarkSeeds } = await import('../src/aflow-seed.js');
  const search = await readTasks(await benchmarkPath('bfcl','search'));
  const heldout = await readTasks(await benchmarkPath('bfcl','test'));
  assert.equal(search.length,200);assert.equal(heldout.length,600);assertDisjoint(search,heldout);
  const seed = benchmarkSeeds(search,['dynamic-policy'])[0];
  assert.equal(seed.organization.initialAgents.length,1);
  assert(seed.prompts.factory.includes('schema and parameter'));
  assert.deepEqual(seed.organization.initialAgents[0].tools,['bfcl_state','bfcl_call','bfcl_respond']);
  const task = [...search,...heldout].find(t=>t.reference?.bfclTaskId==='multi_turn_miss_func_0')!;
  assert(!('reference' in await actorInput(task)));
  const env = await openBFCL(task);
  try {
    const before = await env.request<any>({op:'state'});
    assert(!('initial_config' in before));assert(!('ground_truth' in before));
    const stale = await env.request<any>({op:'call',name:'bfcl_respond',arguments:{turn:1,message:'Invalid stale response'}});
    assert.match(stale.error,/Stale/);
    assert.equal((await env.request<any>({op:'state'})).turn,0);
    let state = before;
    while (!state.complete) {state=await env.request<any>({op:'call',name:'bfcl_respond',arguments:{turn:state.turn,message:'Need clarification'}});}
    assert(state.functions.length>before.functions.length);
    const snapshot = await env.request<any>({op:'snapshot'});
    const grade = await env.request<any>({op:'grade',...snapshot});
    assert.equal(grade.score,0);
  } finally {env.close();}
  // References are used only by this offline scorer fixture, never a model prompt.
  await promisify(execFile)(python,['-c',`
import sys,json,ast,contextlib,os
from pathlib import Path
sys.path.insert(0,'benchmark-hub')
official=Path('../Benchmarks/collections/official-20260930/BFCL/official/berkeley-function-call-leaderboard').resolve()
sys.path.insert(0,str(official));os.environ['BFCL_PROJECT_ROOT']=str(official)
from bfcl_environment import Conversation
from bfcl_bridge import literal_call
with open(os.devnull,'w') as quiet,contextlib.redirect_stdout(quiet):
 env=Conversation(official,'multi_turn_base_0')
 gold=env.load(env.entry['id'],gold=True)['ground_truth']
 for turn,calls in enumerate(gold):
  for source in calls:
   node=ast.parse(source,mode='eval').body
   schema=next(f for f in env.functions if f['name']==node.func.id)
   params={k:ast.literal_eval(v) for k,v in zip(schema['parameters']['properties'],node.args)}
   params.update({k.arg:ast.literal_eval(k.value) for k in node.keywords})
   call={'name':node.func.id,'arguments':params}
   result=env.call('bfcl_call',{'turn':turn,'calls':[{'name':call['name'],'arguments':call['arguments']}]})
   assert not result.get('error'),result
  env.call('bfcl_respond',{'turn':turn,'message':'Done'})
 assert env.grade(env.snapshot())['score']==1
`],{timeout:60000,maxBuffer:2*1024*1024});
});
