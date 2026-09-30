import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { readTasks } from '../src/data.js';
import { benchmarkSeeds } from '../src/aflow-seed.js';

test('remote progress separates known usage and methods while the journal is being appended',async()=>{
  await promisify(execFile)('python3',['-c',`
import contextlib,io,json,tempfile
from pathlib import Path
from unittest.mock import patch
from scripts.automation_experiment import status
with tempfile.TemporaryDirectory() as root:
 out=Path(root);folder=out/'MFlow/search/round-1/pass-0';folder.mkdir(parents=True)
 (folder/'0.usage.json').write_text(json.dumps([{'status':'known','charged':5},{'status':'unknown','charged':99}]))
 (out/'usage.jsonl').write_text(json.dumps({'method':'DyLAN','phase':'DyLAN:pilot','charged':20,'unknownUsage':False})+'\\n'+ '{"partial":')
 af=out/'AFlow/search';af.mkdir(parents=True)
 (af/'results.jsonl').write_text(json.dumps({'round':2,'repeat':0,'score':1,'partialCredit':1,'tokens':20})+'\\n')
 text=io.StringIO()
 with patch('scripts.automation_experiment.urllib.request.urlopen',side_effect=OSError),contextlib.redirect_stdout(text):status(out)
 report=json.loads(text.getvalue())
 assert report['methods']['MFlow']['cost']['search']=={'knownTokens':5,'unknownCalls':1}
 assert report['baselineCost']['DyLAN']['phases']['DyLAN:pilot']['knownTokens']==20
 assert report['baselineCost']['AFlow']['knownTokens']==0
 assert report['methods']['AFlow']['currentValidation']['completed']==1
 assert report['methods']['AFlow']['search']['passRate']==1
 (out/'experiment-manifest.json').write_text(json.dumps({'benchmark':'math'}))
 (af/'results.jsonl').write_text(json.dumps({'round':'round_1','score':1,'tokens':20})+'\\n')
 text=io.StringIO()
 with patch('scripts.automation_experiment.urllib.request.urlopen',side_effect=OSError),contextlib.redirect_stdout(text):status(out)
 report=json.loads(text.getvalue())
 assert report['methods']['AFlow']['currentValidation']['planned']==119
 assert report['methods']['AFlow']['currentValidation']['pass']==0
`]);
});

test('official baseline API worlds are isolated and resumed grading buys no model calls; native static Custom executes Ditto tools', async t=>{
  const python=resolve('../MFlow-baselines/.venv-aflow/bin/python');
  try{await access(python);await readTasks('benchmark:automationbench/search');}catch{t.skip('Official local assets required');return;}
  const task=(await readTasks('benchmark:automationbench/search')).find(t=>t.reference?.automationTaskId==='simple.email_sf_contact_phone_update')!;
  const dir=await mkdtemp(resolve('runs/automation-fixture-'));
  let calls=0,log='',providerMode='normal';
  const provider=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;
    const input=JSON.parse(text);calls++;
    if(providerMode==='unavailable'){res.statusCode=503;res.end(JSON.stringify({error:'Offline fixture provider unavailable'}));return;}
    assert.ok(!text.includes('initial_state')&&!text.includes('_assertion_results'));
    const hasObservation=input.messages.some((m:{role:string})=>m.role==='tool');
    if(input.messages.some((m:{role:string;content:unknown})=>m.role==='tool'&&typeof m.content!=='string')){res.statusCode=400;res.end(JSON.stringify({error:'tool.content must be string'}));return;}
    const message=providerMode==='invalid'?{role:'assistant',content:'Invalid fixture JSON'}:hasObservation?{role:'assistant',content:'<response>Updated the contact.</response>'}:{role:'assistant',content:'',tool_calls:[{id:'update',type:'function',function:{name:'api_fetch',arguments:JSON.stringify({method:'PATCH',url:'https://yourinstance.salesforce.com/services/data/v61.0/sobjects/Contact/003001',params:null,body:JSON.stringify({Phone:'+1-555-0101'})})}}]};
    const usage={prompt_tokens:10,completion_tokens:10,total_tokens:20};
    const finishReason=providerMode==='invalid'||hasObservation?'stop':'tool_calls';
    if(input.stream){
      res.setHeader('Content-Type','text/event-stream');
      const delta={...message,...('tool_calls' in message?{tool_calls:message.tool_calls!.map((call,i)=>({index:i,...call}))}:{})};
      res.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:finishReason}],usage})+'\n\ndata: [DONE]\n\n');
    }else{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message,finish_reason:finishReason}],usage}));}
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));
  const address=provider.address();if(!address||typeof address==='string')throw new Error('Fixture bind failed');
  const config=join(dir,'protocol.json'),port=18297;
  await writeFile(config,JSON.stringify({benchmark:'automationbench',model:'fixture',runDirectory:dir,temperature:0,maxOutputTokens:4096,providerTimeoutMs:30000,concurrency:2,seed:42,aflow:{validationRounds:1}}));
  const env={...process.env,MFLOW_API_KEY:'fixture',MFLOW_BASE_URL:`http://127.0.0.1:${address.port}`,MFLOW_BASELINE_PORT:String(port),MFLOW_BASELINE_PROTOCOL:config,BENCHMARK_HOME:resolve('../Benchmarks'),MFLOW_BASELINE_ENDPOINT:`http://127.0.0.1:${port}`};
  const bridge=spawn(process.execPath,['baselines/bridge.mjs'],{env,stdio:['ignore','pipe','pipe']});bridge.stdout.on('data',x=>log+=x);bridge.stderr.on('data',x=>log+=x);
  const endpoint=`http://127.0.0.1:${port}`;
  const rpc=async(route:string,body:object)=>{const response=await fetch(endpoint+'/'+route,{method:'POST',body:JSON.stringify(body)});const value=await response.json() as any;if(!response.ok)throw new Error(JSON.stringify(value));return value;};
  try{
    for(let i=0;;i++){if(bridge.exitCode!==null)throw new Error(log||'Bridge exited before readiness');try{await fetch(endpoint+'/status');break;}catch{if(i>=300)throw new Error(log||'Bridge readiness exceeded 30 seconds');await new Promise(r=>setTimeout(r,100));}}
    const scope={method:'DyLAN',phase:'pilot',taskId:task.id,benchmarkTaskId:task.id};
    const other={...scope,method:'EvoAgent'};
    await rpc('start',scope);await rpc('start',other);
    await rpc('sample',{...scope,messages:[{role:'user',content:task.prompt}]});
    assert.equal((await rpc('finish',scope)).score,1);assert.equal((await rpc('finish',other)).score,0);
    assert.equal((await rpc('start',scope)).checkpoint,true);assert.equal((await rpc('finish',scope)).score,1);assert.equal(calls,2);
    const init=await rpc('bootstrap',{});
    const result=await promisify(execFile)(python,['-c',`
import sys,asyncio,json
from pathlib import Path
sys.path.insert(0,'baselines')
sys.path.insert(0,str(Path('../MFlow-baselines/sources/AFlow').resolve()))
import automation_aflow as a
from scripts.async_llm import AsyncLLM
seed=json.loads(sys.argv[1]);out=Path(sys.argv[2]);a.prepare(out,Path('../MFlow-baselines/sources/AFlow').resolve())
directory=out/'workspace/AutomationBench/workflows/round_1';directory.mkdir(parents=True,exist_ok=True)
a.write_static(directory,seed['composition'],seed['prompts'],1)
try:a.write_static(directory,'import os\\nclass Workflow: pass','X = "safe"',1)
except ValueError:pass
else:raise AssertionError('Host imports permitted')
AsyncLLM.__call__=lambda self,prompt:a.sample(prompt,self.sys_msg)
row=a.episode(1,0,'search',json.loads(sys.argv[3]));assert row['score']==1,row
print('NATIVE_STATIC_OK')
` ,JSON.stringify(init.seeds[0]),join(dir,'AFlow'),JSON.stringify(task)],{env,maxBuffer:1024*1024,timeout:60000});
    assert.ok(result.stdout.includes('NATIVE_STATIC_OK'));assert.equal(calls,4);
    for(const mode of ['unavailable','invalid']){
      providerMode=mode;
      const response=await fetch(endpoint+'/propose',{method:'POST',body:JSON.stringify({round:2,prompt:'Offline transport fixture only'})});
      assert.equal(response.status,502);
      const error=await response.json() as {fatal:boolean;unavailable:boolean};
      assert.equal(error.fatal,mode==='unavailable');assert.equal(error.unavailable,mode==='unavailable');
    }
  }finally{bridge.kill('SIGKILL');provider.close();await rm(dir,{recursive:true,force:true});}
});

test('native AFlow measures every MAS initialization, optimizes from eligible roots and resumes frozen selection',async t=>{
  const python=resolve('../MFlow-baselines/.venv-aflow/bin/python'),source=resolve('../MFlow-baselines/sources/AFlow');
  try{await access(python);await access(source);}catch{t.skip('Native AFlow environment required');return;}
  const dir=await mkdtemp(resolve('runs/multi-root-fixture-')),seeds=benchmarkSeeds([{benchmark:'automationbench',metric:'automationbench'}],['single','plan-execute']);
  const evaluated:number[]=[];let proposals=0,frozen=0;
  const server=createServer(async(req,res)=>{
    let text='';for await(const part of req)text+=part;const input=JSON.parse(text);let result:unknown;
    if(req.url==='/bootstrap')result={config:{seed:42,maxRounds:2,validationRounds:1,concurrency:1},questionType:'API workflow',seeds,...seeds[0],interface:'Offline fixture only'};
    else if(req.url==='/evaluate'){evaluated.push(input.round);result={score:input.round===3?1:.5,meanTokens:10,tokens:10,organizationSummary:{nodeCalls:{'INFER.REASONING.SAMPLE':1}},failures:[]};}
    else if(req.url==='/propose'){proposals++;assert.ok(input.prompt.includes('plan-execute')||input.prompt.includes("id:'single'"));result={...seeds[0],modification:'An offline local prompt change'};}
    else if(req.url==='/freeze'){frozen=input.round;result={frozen:true};}
    else throw new Error('Unexpected fixture route');
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result));
  });
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw new Error('Bind failed');
  try{
    const args=['scripts/aflow_strategy.py',`http://127.0.0.1:${address.port}`,source,dir];
    await promisify(execFile)(python,args,{timeout:60000,maxBuffer:1024*1024});
    assert.deepEqual(evaluated,[1,2,3]);assert.equal(proposals,1);assert.equal(frozen,3);
    await promisify(execFile)(python,args,{timeout:60000,maxBuffer:1024*1024});
    assert.deepEqual(evaluated,[1,2,3]);assert.equal(proposals,1);
  }finally{server.close();await rm(dir,{recursive:true,force:true});}
});
