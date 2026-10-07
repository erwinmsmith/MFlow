import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {readTasks} from '../src/data.js';
import {grade} from '../src/grading.js';
import {pythonImage} from '../src/python-tool.js';

const exec=promisify(execFile);
test('DROP/MBPP launchers preserve final-only search and direct legacy test on locked full splits',async()=>{
  await exec('python3',['-c',`
import io,json,os,sys,tempfile
from pathlib import Path
from unittest.mock import patch
from scripts.automation_experiment import main
sys.path.insert(0,str(Path('baselines').resolve()))
import bench_common as common
for benchmark,counts in [('drop',(200,800)),('mbpp',(86,341))]:
 with patch.dict(common.PROTOCOL,{'benchmark':benchmark}):
  search,test=common.tasks('search'),common.tasks('test')
  assert (len(search),len(test))==counts
  assert not {r['id'] for r in search}&{r['id'] for r in test}
 with tempfile.TemporaryDirectory() as root:
  calls=[]
  class Child:
   pid=123
   def __init__(self,args,**kwargs):self.bridge=args==['node','baselines/bridge.mjs'];calls.append(args)
   def poll(self):return None if self.bridge else 0
   def terminate(self):pass
   def wait(self,**kwargs):return 0
  with patch.dict(os.environ,{'MFLOW_MODEL':'deepseek-flash','BENCHMARK_HOME':str(Path('../Benchmarks').resolve())}),patch.object(sys,'argv',['runner','--benchmark',benchmark,'--run',root,'--methods','MFlow','AFlow','DyLAN','EvoAgent','AutoAgents','SingleLLM']),patch('scripts.automation_experiment.subprocess.Popen',Child),patch('scripts.automation_experiment.urllib.request.urlopen',return_value=io.StringIO(json.dumps({'runDirectory':root}))),patch('scripts.automation_experiment.time.sleep'):
   main()
  manifest=json.loads((Path(root)/'experiment-manifest.json').read_text())
  assert (manifest['searchCount'],manifest['testCount'])==counts
  assert manifest['searchConfig']['initializations']==['dynamic-policy']
  assert manifest['searchConfig']['maxRounds'] is None and manifest['searchConfig']['validationRounds']==5
  assert json.loads((Path(root)/'scheduler.json').read_text())['testPolicy']=='final-only'
  assert len(calls)==9 and not any('--test-round' in c for c in calls)
  assert all(c[c.index('--benchmark')+1]==benchmark for c in calls if '--benchmark' in c)
  assert all('--phase' in c and c[c.index('--phase')+1]=='test' for c in calls if 'baselines/automation_run.py' in c)
`]);
});

for(const benchmark of ['drop','mbpp'] as const)test(benchmark+' native adapters retain control flow and use task-specific answer contracts',async t=>{
  const python=resolve('../MFlow-baselines/.venv-legacy/bin/python');
  try{await access(python);}catch{t.skip('Legacy baseline environment unavailable');return;}
  await exec(python,['-c',`
import asyncio,contextlib,io,os,sys,tempfile
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path('baselines').resolve()))
import bench_common as b
b.PROTOCOL['benchmark']=sys.argv[1]
answer='Ada' if sys.argv[1]=='drop' else 'def identity(x):\\n    return x'
from dylan import DyLAN
with patch('dylan.call',return_value=answer) as invoke,contextlib.redirect_stdout(io.StringIO()):
 assert DyLAN().solve('Public synthetic task')==answer
 assert invoke.call_count==3
 assert b.text_instruction() in str(invoke.call_args)
 assert '15 trees' not in str(invoke.call_args)
from evoagent import EvoAgent
seen=[]
def respond(messages,**kwargs):
 text=str(messages);seen.append(text)
 if 'Now, you can give the description for a new expert' in text:return 'Expert: specification checker'
 if 'Give the reason first and then give the choice' in text:return 'YES'
 return answer
with patch('evoagent.call',side_effect=respond),contextlib.redirect_stdout(io.StringIO()):
 method=EvoAgent();assert method.solve('Public synthetic task')==answer
assert len(seen)>3 and not any('Final Answer: choice: XX' in s for s in seen)
from autoagents_adapter import AutoAgents
old=Path.cwd()
try:
 with patch('autoagents_adapter.call',return_value='fixture') as invoke:
  agent=AutoAgents()
  from autoagents.system.provider.llm_api import LLMAPI
  asyncio.run(LLMAPI().aask('You are a manager and expert prompt engineer.'))
  assert invoke.call_args.kwargs['tools'] is False
  asyncio.run(LLMAPI().aask('Execute the assigned task.'))
  assert invoke.call_args.kwargs['tools'] is True
  assert 'original task evidence' in str(invoke.call_args)
  assert b.text_instruction() in str(invoke.call_args)
finally:os.chdir(old)
`,benchmark],{maxBuffer:1024*1024,timeout:60000});
});

for(const benchmark of ['drop','mbpp'] as const)test(benchmark+' bridge scores, resumes, isolates references and executes native AFlow operators through Ditto',async t=>{
  const python=resolve('../MFlow-baselines/.venv-aflow/bin/python');
  try{await access(python);await pythonImage();}catch{t.skip('Native AFlow / Docker Python environment required');return;}
  const task=(await readTasks('benchmark:'+benchmark+'/test'))[0];
  const answer=benchmark==='drop'?'fixture answer':'def fixture():\n    return 0';
  const dir=await mkdtemp(resolve('runs/text-fixture-'));let calls=0,log='';
  const provider=createServer(async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    JSON.parse(raw);calls++;
    assert.ok(!raw.includes('test_list')&&!raw.includes('test_setup_code'));
    const content=raw.includes('solution_letter')?'<thought>fixture</thought><solution_letter>A</solution_letter>':answer;
    const usage={prompt_tokens:10,completion_tokens:10,total_tokens:20};
    res.setHeader('Content-Type','text/event-stream');
    res.end('data: '+JSON.stringify({choices:[{index:0,delta:{role:'assistant',content},finish_reason:'stop'}],usage})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));const address=provider.address();assert.ok(address&&typeof address!=='string');
  const config={...JSON.parse(await readFile('configs/'+benchmark+'-baselines.json','utf8')),runDirectory:dir};
  await writeFile(join(dir,'config.json'),JSON.stringify(config));
  const env={...process.env,MFLOW_BASELINE_PROTOCOL:join(dir,'config.json'),MFLOW_BASELINE_PORT:'0',MFLOW_BASE_URL:`http://127.0.0.1:${address.port}`,MFLOW_API_KEY:'fixture-no-paid-access',BENCHMARK_HOME:resolve('../Benchmarks')};
  const bridge=spawn(process.execPath,['baselines/bridge.mjs'],{env,stdio:['ignore','pipe','pipe']});
  bridge.stdout.on('data',data=>log+=data);bridge.stderr.on('data',data=>log+=data);
  try{
    let port=0;
    for(let i=0;i<200;i++){try{port=JSON.parse(await readFile(join(dir,'bridge.json'),'utf8')).port;break;}catch{}if(bridge.exitCode!==null)throw new Error(log);await new Promise(r=>setTimeout(r,50));}
    assert.ok(port,log);const endpoint=`http://127.0.0.1:${port}`;
    const rpc=async(route:string,body:unknown)=>{const r=await fetch(endpoint+'/'+route,{method:'POST',body:JSON.stringify(body)});const result=await r.json() as any;assert.ok(r.ok,JSON.stringify(result));return result;};
    const boot=await rpc('bootstrap',{});assert.equal(boot.dataset,benchmark.toUpperCase());
    const scope={method:'DyLAN',phase:'test',taskId:'fixture',benchmarkTaskId:task.id};
    assert.deepEqual(await rpc('start',scope),{checkpoint:false});
    const evidence=await rpc('search',{...scope,query:'fixture'});assert.equal(evidence.results[0].content,task.prompt);
    const sampled=await rpc('sample',{...scope,messages:[{role:'user',content:task.prompt}]});assert.equal(sampled.message.content,answer);
    const expected=await grade(task,answer),result=await rpc('finish',{...scope,answer});assert.equal(result.score,expected.score);assert.equal(result.f1,expected.f1);
    assert.equal((await rpc('start',scope)).answer,answer);assert.deepEqual(await rpc('finish',scope),result);assert.equal(calls,1);
    const wrong=await fetch(endpoint+'/start',{method:'POST',body:JSON.stringify({...scope,phase:'search'})});assert.equal(wrong.status,502);
    await exec(python,['-c',`
import asyncio,json,sys
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path('baselines').resolve()))
import automation_aflow as a
from bench_common import SCOPE,benchmark_rpc
seed=json.loads(sys.argv[1]);task=json.loads(sys.argv[2]);out=a.RUNS/'AFlow'
# Exercise the real executable entry's import path, before any controller calls.
class EntryChecked(Exception):pass
def enter(*args,**kwargs):
 import search_evidence
 raise EntryChecked()
old_path=sys.path[:]
with patch.object(sys,'argv',['automation_aflow.py']),patch.object(a.runpy,'run_path',side_effect=enter):
 try:a.main()
 except EntryChecked:pass
 else:raise AssertionError('Entry fixture was not reached')
sys.path[:]=old_path
a.prepare(out,a.SOURCES/'AFlow')
folder=out/f'workspace/{a.DATASET}/workflows/round_1';folder.mkdir(parents=True)
a.write_static(folder,seed['composition'],seed['prompts'],1)
SCOPE.set(('AFlow','test','native-fixture'));benchmark_rpc('start',task)
from scripts.async_llm import AsyncLLM,LLMConfig
AsyncLLM.__call__=lambda self,prompt:a.sample(prompt,self.sys_msg)
agent=a.load(1)(name=a.DATASET,llm_config=LLMConfig({'model':'fixture','key':'fixture','base_url':'unused'}),dataset=a.DATASET)
answer,_=asyncio.run(agent(task['prompt']));assert answer==sys.argv[3]
assert asyncio.run(agent.sc_ensemble(solutions=[answer,answer],**({} if a.DATASET=='DROP' else {'problem':task['prompt']})))['response']==answer
benchmark_rpc('finish',task,answer=answer)
try:a.write_static(folder,seed['composition'].replace('operator.Custom','operator.Test'),seed['prompts'],1)
except ValueError:pass
else:raise AssertionError('Hidden-test/host-execution operator allowed')
# DROP optimization uses F1, while reported full-match passRate stays binary.
row={'score':0,'f1':.5,'partialCredit':.5,'tokens':1,'answer':'fixture','taskId':'fixture'}
with patch.object(a,'tasks',return_value=[{'id':'fixture','prompt':'public'}]),patch.object(a,'episode',return_value=row):
 result=asyncio.run(a.evaluate_static(1,0,{},1));assert result['score']==.5 and result['passRate']==0
`,JSON.stringify(boot.seeds[0]),JSON.stringify(task),answer],{env:{...env,MFLOW_BASELINE_ENDPOINT:endpoint},timeout:60000,maxBuffer:1024*1024});
    assert.equal(calls,3);
  }finally{bridge.kill('SIGKILL');provider.close();await rm(dir,{recursive:true,force:true});}
});
