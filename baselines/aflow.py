"""Run the official AFlow optimizer and workflows; swap only provider, data and scoring adapters."""
import argparse, asyncio, hashlib, json, os, random, sys, time
from pathlib import Path
from bench_common import ROOT, SOURCES, RUNS, SCOPE, BudgetStop, call, tasks, grade, save_row, usage, freeze_run
p=argparse.ArgumentParser();p.add_argument('--phase',choices=['pilot','search-test'],required=True);args=p.parse_args()
source=SOURCES/'AFlow';sys.path.insert(0,str(source));os.chdir(source)
from scripts.async_llm import AsyncLLM, LLMConfig
from scripts.optimizer import Optimizer
from benchmarks.math import MATHBenchmark
from benchmarks.benchmark import BaseBenchmark
import numpy as np
random.seed(42);np.random.seed(42)
config=LLMConfig({'model':'deepseek-flash','temperature':0,'key':'local-ditto-bridge','base_url':'http://127.0.0.1:8197/v1'})
async def invoke(self,prompt):
    messages=([{'role':'system','content':self.sys_msg}] if self.sys_msg else [])+[{'role':'user','content':prompt}]
    return call(messages)
AsyncLLM.__call__=invoke
# Configuration exposes native operators that do not require arbitrary code execution.
# Python execution and web search are excluded from the common-tool comparison.
optimizer=Optimizer(dataset='MATH',question_type='math',opt_llm_config=config,exec_llm_config=config,operators=['Custom','ScEnsemble'],sample=4,check_convergence=False,optimized_path='workspace',initial_round=1,max_rounds=4,validation_rounds=1)
phase='pilot' if args.phase=='pilot' else 'search'
async def load_data(self,specific_indices=None):
    rows=tasks('test' if phase=='test' else 'search')
    if phase=='pilot':rows=rows[:2]
    return [{'id':t['id'],'problem':t['prompt'],'solution':t['answer'],'task':t} for t in rows]
BaseBenchmark.load_data=load_data
async def evaluate_all(self,data,agent,max_concurrent_tasks=1):
    return [await self.evaluate_problem(t,agent) for t in data]
BaseBenchmark.evaluate_all_problems=evaluate_all
async def evaluate(self,problem,agent):
    round_name=Path(self.log_path).name
    execution_id=problem['id'] if phase=='test' else round_name+'/'+problem['id']
    token=SCOPE.set(('AFlow',phase,execution_id));status='completed';output='';started=time.monotonic()
    try:
        try:output,_=await self._generate_output(agent,problem['problem'])
        except BudgetStop as e:
            if any(k in e.reason for k in ['GLOBAL_BUDGET','SEARCH_BUDGET']):raise
            status=e.reason
        except Exception as e:
            status='execution_error: '+repr(e)
        score=grade(problem['task'],str(output));charged=usage('AFlow',phase,execution_id)
        save_row(RUNS/'AFlow'/phase/'results.jsonl',{'taskId':problem['id'],'round':round_name,'score':score,'answer':output,'tokens':charged,'status':status,'seconds':time.monotonic()-started})
        if score==0 and phase=='search':self.log_mismatch(problem['problem'],problem['solution'],output,output)
        print(json.dumps({'phase':phase,'round':round_name,'taskId':problem['id'],'score':score,'tokens':charged}),flush=True)
        self.charged=getattr(self,'charged',0)+charged
        return problem['problem'],output,problem['solution'],score,self.charged
    finally:SCOPE.reset(token)
MATHBenchmark.evaluate_problem=evaluate
async def main():
    global phase
    workflows='workspace/MATH/workflows'
    freeze_run(RUNS/'AFlow'/args.phase,'AFlow',args.phase)
    if args.phase=='pilot':
        cls=optimizer.graph_utils.load_graph(1,workflows);agent=cls(name='MATH',llm_config=config,dataset='MATH')
        bench=MATHBenchmark('MATH','unused',str(RUNS/'AFlow/pilot/round_1'))
        for row in await bench.load_data():await bench.evaluate_problem(row,agent)
        return
    out=RUNS/'AFlow';out.mkdir(parents=True,exist_ok=True)
    if (out/'frozen.json').exists():
        frozen=json.loads((out/'frozen.json').read_text());number=frozen['round']
        for name,digest in frozen['files'].items():
            if hashlib.sha256(Path(workflows,f'round_{number}',name).read_bytes()).hexdigest()!=digest:raise RuntimeError('Frozen workflow changed')
        await test(number,out,workflows)
        return
    if (out/'search/results.jsonl').exists():raise RuntimeError('Interrupted search requires inspection; refuse duplicate evaluations')
    stop='iterations'
    for round_number in range(1,5):
        optimizer.round=round_number
        token=SCOPE.set(('AFlow','search',f'optimizer-round-{round_number}'))
        try:await optimizer._optimize_graph()
        except BudgetStop as e:stop=e.reason;break
        finally:SCOPE.reset(token)
    records=json.loads(Path(workflows,'results.json').read_text())
    # Only official completed 119-task validation records are eligible.
    logged=[json.loads(s) for s in (out/'search/results.jsonl').read_text().splitlines()]
    complete=[r for r in records if sum(x['round']==f"round_{r['round']}" for x in logged)==119]
    if not complete:raise RuntimeError('No fully evaluated AFlow candidate')
    best=max(complete,key=lambda r:(r['score'],-r['round']));number=best['round']
    files={n:hashlib.sha256(Path(workflows,f'round_{number}',n).read_bytes()).hexdigest() for n in ['graph.py','prompt.py']}
    (out/'frozen.json').write_text(json.dumps({'round':number,'validationScore':best['score'],'stop':stop,'files':files,'model':'deepseek-flash','operators':['Custom','ScEnsemble'],'frozenBeforeTest':True},indent=2)+'\n')
    await test(number,out,workflows)
async def test(number,out,workflows):
    global phase
    phase='test';cls=optimizer.graph_utils.load_graph(number,workflows);agent=cls(name='MATH',llm_config=config,dataset='MATH')
    bench=MATHBenchmark('MATH','unused',str(out/'test'/f'round_{number}'))
    results=out/'test/results.jsonl'
    done={r['taskId'] for r in map(json.loads,results.read_text().splitlines())} if results.exists() else set()
    for row in await bench.load_data():
        if row['id'] not in done:await bench.evaluate_problem(row,agent)
    rows=[json.loads(s) for s in (out/'test/results.jsonl').read_text().splitlines()]
    assert len(rows)==486 and len({r['taskId'] for r in rows})==486
    (out/'test/summary.json').write_text(json.dumps({'method':'AFlow','count':486,'correct':sum(r['score'] for r in rows),'tokens':sum(r['tokens'] for r in rows),'selectedRound':number},indent=2)+'\n')
asyncio.run(main())
