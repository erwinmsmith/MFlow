"""Run the official AFlow optimizer and workflows; swap only provider, data and scoring adapters."""
import argparse, asyncio, hashlib, json, os, random, sys, time
from pathlib import Path
from bench_common import ROOT, SOURCES, RUNS, SCOPE, PROTOCOL, BudgetStop, call, tasks, grade, save_row, usage, freeze_run
from repairs import validate_workflow, install_aflow_python
p=argparse.ArgumentParser();p.add_argument('--phase',choices=['pilot','search-test'],required=True);p.add_argument('--test-round',type=int);p.add_argument('--test-out',type=Path);args=p.parse_args()
if (args.test_round is None)!=(args.test_out is None) or args.test_round is not None and args.test_round<1:p.error('Supply a positive --test-round with --test-out')
test_out=args.test_out or RUNS/'AFlow/test'
source=SOURCES/'AFlow';sys.path.insert(0,str(source));os.chdir(source)
from scripts.async_llm import AsyncLLM, LLMConfig
from scripts.optimizer import Optimizer
from benchmarks.math import MATHBenchmark
from benchmarks.benchmark import BaseBenchmark
import workspace.MATH.workflows.template.operator as math_operator
import scripts.operators as original_operator
install_aflow_python(math_operator,original_operator)
import numpy as np
random.seed(42);np.random.seed(42)
config=LLMConfig({'model':PROTOCOL['model'],'temperature':PROTOCOL['temperature'],'key':'local-ditto-bridge','base_url':'http://127.0.0.1:8197/v1'})
async def invoke(self,prompt):
    messages=([{'role':'system','content':self.sys_msg}] if self.sys_msg else [])+[{'role':'user','content':prompt}]
    try:SCOPE.get();return call(messages)
    except LookupError:
        token=SCOPE.set(('AFlow','search',f'optimizer-round-{optimizer.round}'))
        try:return call(messages)
        finally:SCOPE.reset(token)
AsyncLLM.__call__=invoke
original_format=AsyncLLM.call_with_format
async def formatted(self,prompt,formatter):
    response=await original_format(self,prompt,formatter)
    if getattr(getattr(formatter,'model',None),'__name__','')!='GraphOptimize':return response
    while True:
        try:
            repaired=validate_workflow(response)
            if repaired!=response:save_row(RUNS/'AFlow/repairs.jsonl',{'round':optimizer.round+1,'kind':'uncomment_prompt_or_remove_fences'})
            return repaired
        except (SyntaxError,ValueError,KeyError) as error:
            save_row(RUNS/'AFlow/repairs.jsonl',{'round':optimizer.round+1,'kind':'code_format_repair','error':str(error)})
            response=await original_format(self,'Repair Python syntax and missing prompt definitions in this workflow. Preserve its algorithm and modification. Return all fields. Do not solve benchmark questions.\n'+json.dumps(response)+'\nError: '+str(error),formatter)
AsyncLLM.call_with_format=formatted
native=PROTOCOL['aflow']
optimizer=Optimizer(dataset='MATH',question_type='math',opt_llm_config=config,exec_llm_config=config,operators=native['operators'],sample=4,check_convergence=native['checkConvergence'],optimized_path='workspace',initial_round=1,max_rounds=native['maxRounds'],validation_rounds=native['validationRounds'])
native_evaluate=optimizer.evaluation_utils.evaluate_graph
async def export_round(optimizer,directory,validation_n,data,initial=False):
    score=await native_evaluate(optimizer,directory,validation_n,data,initial)
    number=optimizer.round if initial else optimizer.round+1
    files={n:hashlib.sha256(Path(directory,n).read_bytes()).hexdigest() for n in ['graph.py','prompt.py']}
    folder=RUNS/'AFlow/round-candidates';folder.mkdir(parents=True,exist_ok=True)
    path=folder/f'round-{number}.json';path.with_suffix('.tmp').write_text(json.dumps({'round':number,'validationScore':score,'files':files,'frozenBeforeTest':True})+'\n');path.with_suffix('.tmp').replace(path)
    return score
optimizer.evaluation_utils.evaluate_graph=export_round
phase='pilot' if args.phase=='pilot' else 'search'
recovered_search={}
validation_repeat=0
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
    if phase=='search' and (round_name,validation_repeat,problem['id']) in recovered_search:
        row=recovered_search[round_name,validation_repeat,problem['id']]
        self.charged=getattr(self,'charged',0)+row['tokens']
        return problem['problem'],row['answer'],problem['solution'],row['score'],float(self.charged)
    execution_id=('observe-round/' if args.test_round else '')+round_name+'/'+problem['id']
    token=SCOPE.set(('AFlow',phase,execution_id));status='completed';output='';started=time.monotonic()
    try:
        try:output,_=await self._generate_output(agent,problem['problem'])
        except BudgetStop as e:
            if any(k in e.reason for k in ['GLOBAL_BUDGET','SEARCH_BUDGET']):raise
            status=e.reason
        except Exception as e:
            status='execution_error: '+repr(e)
        score=grade(problem['task'],str(output));charged=usage('AFlow',phase,execution_id)
        save_row((test_out if phase=='test' else RUNS/'AFlow'/phase)/'results.jsonl',{'taskId':problem['id'],'round':round_name,'repeat':validation_repeat,'score':score,'answer':output,'tokens':charged,'status':status,'seconds':time.monotonic()-started})
        if score==0 and phase=='search':self.log_mismatch(problem['problem'],problem['solution'],output,output)
        print(json.dumps({'phase':phase,'round':round_name,'taskId':problem['id'],'score':score,'tokens':charged}),flush=True)
        self.charged=getattr(self,'charged',0)+charged
        return problem['problem'],output,problem['solution'],score,float(self.charged)
    finally:SCOPE.reset(token)
MATHBenchmark.evaluate_problem=evaluate
def install_search_resume(out,workflows):
    """Checkpoint candidate identity and RNG; cache rows by round/pass/task."""
    checkpoint_path=out/'controller.json'
    checkpoint=json.loads(checkpoint_path.read_text()) if checkpoint_path.exists() else {'round':1,'phase':'generating'}
    def persist():
        checkpoint['random']=random.getstate()
        state=np.random.get_state();checkpoint['numpy']=[state[0],state[1].tolist(),int(state[2]),int(state[3]),float(state[4])]
        temp=checkpoint_path.with_suffix('.tmp');temp.write_text(json.dumps(checkpoint)+'\n');temp.replace(checkpoint_path)
    if 'random' in checkpoint:
        def tuples(x):return tuple(tuples(v) for v in x) if isinstance(x,list) else x
        random.setstate(tuples(checkpoint['random']))
        state=checkpoint['numpy'];np.random.set_state((state[0],np.array(state[1],dtype=np.uint32),*state[2:]))
    # Legacy interrupted candidates need an explicit, audited recovery checkpoint.
    elif recovered_search and any(int(k[0].split('_')[-1])>1 for k in recovered_search):
        raise RuntimeError('Legacy candidate needs controller.json with verified parent, experience and workflow hashes')
    original_create=optimizer.experience_utils.create_experience_data
    def create(parent,modification):
        experience=original_create(parent,modification)
        directory=workflows/f'round_{optimizer.round+1}'
        checkpoint.update(round=optimizer.round,phase='evaluating',experience=experience,
            files={n:hashlib.sha256((directory/n).read_bytes()).hexdigest() for n in ('graph.py','prompt.py')})
        persist();return experience
    optimizer.experience_utils.create_experience_data=create
    original_evaluate=optimizer.evaluation_utils.evaluate_graph
    async def evaluate_round(optimizer,directory,validation_n,data,initial=False):
        global validation_repeat
        number=optimizer.round if initial else optimizer.round+1
        data[:]=[r for r in data if r['round']!=number]
        from scripts.evaluator import Evaluator
        original_graph=Evaluator.graph_evaluate
        validation_repeat=-1
        async def graph_evaluate(self,*args,**kwargs):
            global validation_repeat
            validation_repeat+=1
            return await original_graph(self,*args,**kwargs)
        Evaluator.graph_evaluate=graph_evaluate
        try:return await original_evaluate(optimizer,directory,validation_n,data,initial)
        finally:Evaluator.graph_evaluate=original_graph
    optimizer.evaluation_utils.evaluate_graph=evaluate_round
    original_optimize=optimizer._optimize_graph
    async def optimize_round():
        try:
            if checkpoint['phase']=='evaluating':
                directory=workflows/f'round_{optimizer.round+1}'
                for name,digest in checkpoint['files'].items():
                    if hashlib.sha256((directory/name).read_bytes()).hexdigest()!=digest:raise SystemExit('Interrupted candidate changed')
                optimizer.graph=optimizer.graph_utils.load_graph(optimizer.round+1,str(workflows))
                data=optimizer.data_utils.load_results(str(workflows))
                score=await evaluate_round(optimizer,str(directory),optimizer.validation_rounds,data)
                optimizer.experience_utils.update_experience(str(directory),checkpoint['experience'],score)
            else:
                checkpoint.update(round=optimizer.round,phase='generating');persist()
                score=await original_optimize()
        except Exception:
            checkpoint.update(round=optimizer.round+1,phase='generating');persist()
            raise
        checkpoint.update(round=optimizer.round+1,phase='generating');persist()
        return score
    optimizer._optimize_graph=optimize_round
    optimizer.round=checkpoint['round']
    optimizer.max_rounds=max(0,native['maxRounds']-(optimizer.round-1))

async def main():
    global phase
    workflows='workspace/MATH/workflows'
    if args.test_round is not None:
        freeze_run(test_out,'AFlow','round-test')
        frozen=json.loads((RUNS/f'AFlow/round-candidates/round-{args.test_round}.json').read_text())
        for name,digest in frozen['files'].items():
            if hashlib.sha256(Path(workflows,f'round_{args.test_round}',name).read_bytes()).hexdigest()!=digest:raise RuntimeError('Frozen round workflow changed')
        await test(args.test_round,RUNS/'AFlow',workflows)
        return
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
    if (out/'search/results.jsonl').exists():
        saved=[json.loads(s) for s in (out/'search/results.jsonl').read_text().splitlines()]
        allowed={t['id'] for t in tasks('search')}
        for row in saved:
            key=(row['round'],row.get('repeat',0),row['taskId'])
            if row['taskId'] not in allowed or key in recovered_search:raise RuntimeError('Invalid or duplicate search row')
            recovered_search[key]=row
    install_search_resume(out,Path(workflows))
    # Execute the official top-level optimizer, including its convergence/round controls.
    await asyncio.to_thread(optimizer.optimize,'Graph')
    stop='official_optimizer_returned'
    records=json.loads(Path(workflows,'results.json').read_text())
    # Only official completed 119-task validation records are eligible.
    logged=[json.loads(s) for s in (out/'search/results.jsonl').read_text().splitlines()]
    complete=[r for r in records if sum(x['round']==f"round_{r['round']}" for x in logged)==len(tasks('search'))*native['validationRounds']]
    if not complete:raise RuntimeError('No fully evaluated AFlow candidate')
    best=max(complete,key=lambda r:(r['score'],-r['round']));number=best['round']
    files={n:hashlib.sha256(Path(workflows,f'round_{number}',n).read_bytes()).hexdigest() for n in ['graph.py','prompt.py']}
    (out/'frozen.json').write_text(json.dumps({'round':number,'validationScore':best['score'],'stop':stop,'files':files,'model':PROTOCOL['model'],'operators':native['operators'],'frozenBeforeTest':True},indent=2)+'\n')
    await test(number,out,workflows)
async def test(number,out,workflows):
    global phase
    phase='test';cls=optimizer.graph_utils.load_graph(number,workflows);agent=cls(name='MATH',llm_config=config,dataset='MATH')
    bench=MATHBenchmark('MATH','unused',str(test_out/f'round_{number}'))
    results=test_out/'results.jsonl'
    done={r['taskId'] for r in map(json.loads,results.read_text().splitlines())} if results.exists() else set()
    for row in await bench.load_data():
        if row['id'] not in done:await bench.evaluate_problem(row,agent)
    rows=[json.loads(s) for s in results.read_text().splitlines()]
    assert len(rows)==486 and len({r['taskId'] for r in rows})==486
    (test_out/'summary.json').write_text(json.dumps({'method':'AFlow','count':486,'correct':sum(r['score'] for r in rows),'passRate':sum(r['score'] for r in rows)/486,'tokens':sum(r['tokens'] for r in rows),'selectedRound':number,'purpose':'observation-only' if args.test_round else 'final-selected-by-search'},indent=2)+'\n')
if __name__=='__main__':
    import runpy
    from bench_common import TransportFailure
    call=runpy.run_path(str(ROOT/'scripts/resume_aflow_test.py'))['guard_transport'](call,TransportFailure)
    asyncio.run(main())
