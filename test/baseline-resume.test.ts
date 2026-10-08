import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

test('AFlow test recovery propagates outages past native answer retries without changing model-limit handling',()=>{
  const output=execFileSync('python3',['-c',`
import runpy,urllib.error
m=runpy.run_path('scripts/resume_aflow_test.py')
class TransportFailure(RuntimeError):pass
calls=[]
def failed(error):
 def call():
  calls.append(1)
  raise error
 return call
for error in [urllib.error.URLError('offline'), TimeoutError('offline'), TransportFailure('fetch failed'), TransportFailure('')]:
 try:m['guard_transport'](failed(error),TransportFailure)()
 except m['InfrastructureUnavailable']:pass
 except Exception:raise AssertionError('Native retry would swallow infrastructure failure')
 else:raise AssertionError('Missing interruption')
assert len(calls)==4
try:m['guard_transport'](failed(TransportFailure('Provider context/output ceiling reached; response is incomplete')),TransportFailure)()
except TransportFailure:pass
else:raise AssertionError('Changed model-limit semantics')
assert m['guard_transport'](lambda:'complete but wrong',TransportFailure)()=='complete but wrong'
try:m['guard_transport'](failed(TransportFailure('[DEGENERATE_OUTPUT] repeated cycle')),TransportFailure)()
except m['InfrastructureUnavailable']:raise AssertionError('Model fault classified as outage')
except RuntimeError:pass
else:raise AssertionError('Model fault swallowed')
print('OK')
`],{encoding:'utf8'});
  assert.equal(output.trim(),'OK');
});

test('search evidence references preserve every value and repeated internal graph',()=>{
  execFileSync('python3',['-c',`
from scripts.search_evidence import compact_evidence
import json
graph={'nodes':[{'id':'root/reason','type':'INFER.REASONING.SAMPLE','config':'x'*500}]}
value={'passes':[{'graphs':[graph]*40,'program':'complete source '*40} for _ in range(5)]}
packed=compact_evidence(value)
def expand(x):
 if isinstance(x,dict):
  if list(x)==['$evidence_ref']:return packed['definitions'][x['$evidence_ref']]
  return {k:expand(v) for k,v in x.items()}
 if isinstance(x,list):return [expand(v) for v in x]
 return x
assert expand(packed['data'])==value
assert len(json.dumps(packed))<len(json.dumps(value))/2
assert compact_evidence({'$evidence_ref':0,'x':'y'*300})=={'$evidence_ref':0,'x':'y'*300}
`]);
});

test('search comparisons retain regressions and omit incomplete or missing historical task scores',()=>{
  execFileSync('python3',['-c',`
from scripts.search_evidence import paired_outcomes
def row(a,b):return {'taskScores':[{'taskId':'a','score':a},{'taskId':'b','score':b}]}
result=paired_outcomes([row(0,1),row(1,1)],[row(1,1),row(1,0)])
assert result['pairedTasks']==2
assert result['improved']==[{'taskId':'a','before':0.5,'after':1.0}]
assert result['regressed']==[{'taskId':'b','before':1.0,'after':0.5}]
assert paired_outcomes([{},{}],[row(1,1),row(1,1)])['pairedTasks']==0
assert paired_outcomes([row(0,1),{}],[row(1,1),row(1,0)])['pairedTasks']==0
`]);
});

test('MATH candidate recovery keeps completed pass rows and verifies frozen code',()=>{
  execFileSync('python3',['-c',`
import ast,asyncio,hashlib,json,random,tempfile,types,sys
from pathlib import Path
source=ast.parse(Path('baselines/aflow.py').read_text())
definitions=[n for n in source.body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in ('evaluate','install_search_resume')]
class RNG:
 uint32=int
 @property
 def random(self):return self
 def get_state(self):return ('fixture',types.SimpleNamespace(tolist=lambda:[]),0,0,0.0)
 def array(self,x,dtype):return x
 def set_state(self,x):pass
class Evaluator:
 async def graph_evaluate(self):return None
sys.modules['scripts.evaluator']=types.SimpleNamespace(Evaluator=Evaluator)
with tempfile.TemporaryDirectory() as tmp:
 out=Path(tmp);workflows=out/'workflows';directory=workflows/'round_2';directory.mkdir(parents=True)
 for name in ('graph.py','prompt.py'):(directory/name).write_text('frozen')
 checkpoint={'round':1,'phase':'evaluating','experience':{'father node':1},'files':{n:hashlib.sha256((directory/n).read_bytes()).hexdigest() for n in ('graph.py','prompt.py')}}
 (out/'controller.json').write_text(json.dumps(checkpoint))
 ns=dict(Path=Path,json=json,hashlib=hashlib,random=random,np=RNG(),native={'maxRounds':20},recovered_search={},phase='search',validation_repeat=0)
 exec(compile(ast.Module(body=definitions,type_ignores=[]),'baselines/aflow.py','exec'),ns)
 ns['recovered_search']={('round_2',1,'task'):{'answer':'saved wrong answer','score':0,'tokens':7}}
 bench=types.SimpleNamespace(log_path=str(directory))
 ns['validation_repeat']=1
 result=asyncio.run(ns['evaluate'](bench,{'id':'task','problem':'fixture','solution':'gold'},None))
 assert result[1:4]==('saved wrong answer','gold',0) and bench.charged==7
 ns['recovered_search']={}
 seen=[]
 async def evaluate_round(opt,path,n,data,initial=False):
  assert data==[{'round':1,'score':1}]
  for repeat in range(n):
   await Evaluator().graph_evaluate();seen.append(ns['validation_repeat'])
  return 0.5
 optimizer=types.SimpleNamespace(round=1,validation_rounds=2,
  graph_utils=types.SimpleNamespace(load_graph=lambda n,p:n),
  data_utils=types.SimpleNamespace(load_results=lambda p:[{'round':1,'score':1},{'round':2,'score':0}]),
  experience_utils=types.SimpleNamespace(create_experience_data=lambda *a:{},update_experience=lambda *a:None),
  evaluation_utils=types.SimpleNamespace(evaluate_graph=evaluate_round),_optimize_graph=lambda:None)
 ns['optimizer']=optimizer
 ns['install_search_resume'](out,workflows)
 assert asyncio.run(optimizer._optimize_graph())==0.5 and seen==[0,1]
 assert json.loads((out/'controller.json').read_text())['round']==2
 # A changed artifact must abort outside native skip-on-error handling.
 (out/'controller.json').write_text(json.dumps(checkpoint));(directory/'graph.py').write_text('tampered')
 ns['install_search_resume'](out,workflows)
 try:asyncio.run(optimizer._optimize_graph())
 except SystemExit:pass
 else:raise AssertionError('Changed candidate accepted')
`]);
});
