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
}finally{rmSync(run,{recursive:true,force:true});}
`],{timeout:60000,maxBuffer:2*1024*1024});
});
