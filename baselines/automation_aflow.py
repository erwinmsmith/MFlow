"""Official AFlow static workflows; reuse the native search/checkpoint controller."""
import asyncio
import argparse
import ast
import hashlib
import importlib.util
import json
import os
import contextvars
import runpy
import sys
from pathlib import Path
from bench_common import ROOT, SOURCES, RUNS, SCOPE, PROTOCOL, endpoint, tasks, call, benchmark_rpc, usage, save_row, freeze_run, TransportFailure

DATASET='HLE' if PROTOCOL.get('benchmark')=='hle' else 'AutomationBench'
EXECUTION_TOOLS=contextvars.ContextVar('aflow_execution_tools',default=True)

def prepare(out,source):
    target=out/f'workspace/{DATASET}/workflows/template'
    target.mkdir(parents=True,exist_ok=True)
    for name in ['operator.py','operator_an.py','operator.json','op_prompt.py']:
        text=(source/'workspace/MATH/workflows/template'/name).read_text().replace('workspace.MATH','workspace.'+DATASET)
        if name=='op_prompt.py':
            text=text.replace('math problem','academic question' if DATASET=='HLE' else 'business workflow').replace('\\boxed{answer}','Explanation: reasoning; Answer: precise answer; Confidence: 0-100%' if DATASET=='HLE' else 'Final Summary: completed effects').replace('mathematical','academic' if DATASET=='HLE' else 'workflow')
            text=text.replace('Carefully evaluate these solutions and identify the answer that appears most frequently across them. This consistency in answers is crucial for determining the most reliable solution.',
                'Select the solution best supported by the original question, exact assumptions and decisive evidence. Agreement is useful only when independently justified; do not prefer a shared error.' if DATASET=='HLE' else
                'Select the report best supported by actual API observations and the requested postconditions. Shared wording is not proof of completed effects. Identify unsupported claims, missing effects and duplicates. This selection stage must not execute writes.')
        (target/name).write_text(text)
    activate(out,source)
    freeze_run(out,'AFlow','search-test')

def activate(out,source):
    sys.path.insert(0,str(source));sys.path.insert(0,str(out))
    from importlib import import_module
    module=import_module(f'workspace.{DATASET}.workflows.template.operator')
    # Preserve native operators; only control whether this stage may execute tools.
    if not getattr(module,'_mflow_stages',False):
        original=module.Custom.__call__
        async def custom(self,input,instruction):
            token=EXECUTION_TOOLS.set(not instruction.startswith('[PLAN ONLY]'))
            try:return await original(self,input,instruction)
            finally:EXECUTION_TOOLS.reset(token)
        module.Custom.__call__=custom
        ensemble=module.ScEnsemble.__call__
        async def select(self,*args,**kwargs):
            token=EXECUTION_TOOLS.set(False)
            try:return await ensemble(self,*args,**kwargs)
            finally:EXECUTION_TOOLS.reset(token)
        module.ScEnsemble.__call__=select
        module._mflow_stages=True
    if DATASET=='HLE':
        from repairs import install_aflow_python
        install_aflow_python(module)

def write_static(directory,graph,prompts,number):
    forbidden={'open','exec','eval','compile','__import__','getattr','setattr','globals','locals','vars','input','breakpoint'}
    for node in ast.walk(ast.parse(graph)):
        if isinstance(node,(ast.Import,ast.ImportFrom)) or isinstance(node,ast.Name) and (node.id in forbidden or node.id.startswith('__')):
            raise ValueError('Workflow imports and host execution are unavailable')
        if isinstance(node,ast.Attribute) and (node.attr.startswith('_') or node.attr in {'os','sys','subprocess','requests','socket','client','create_subprocess_exec','create_subprocess_shell'}):
            raise ValueError('Workflow private/host capabilities are unavailable')
        if isinstance(node,ast.Attribute) and node.attr=='Programmer' and DATASET!='HLE':raise ValueError('Programmer is unavailable for API workflows')
    for node in ast.parse(prompts).body:
        if not isinstance(node,ast.Assign) or not isinstance(node.value,ast.Constant) or not isinstance(node.value.value,str) or any(not isinstance(t,ast.Name) for t in node.targets):
            raise ValueError('Prompt file must define literal string constants only')
    from scripts.prompts.optimize_prompt import WORKFLOW_TEMPLATE
    (directory/'graph.py').write_text(WORKFLOW_TEMPLATE.format(graph=graph,round=number,dataset=DATASET))
    (directory/'prompt.py').write_text(prompts)
    (directory/'__init__.py').write_text('')

async def sample(prompt,system):
    return await asyncio.to_thread(call,([{'role':'system','content':system}] if system else [])+[{'role':'user','content':prompt}],tools=EXECUTION_TOOLS.get())

def load(number):
    path=RUNS/f'AFlow/workspace/{DATASET}/workflows/round_{number}/graph.py'
    name=f'workspace.{DATASET}.workflows.round_{number}.graph'
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.Workflow

def episode(number,repeat,phase,task):
    execution=os.environ.get('MFLOW_BASELINE_EXECUTION_NAMESPACE','')+f'round-{number}/pass-{repeat}/{task["id"]}'
    output=Path(os.environ['MFLOW_AFLOW_TEST_OUT']) if phase=='test' and os.environ.get('MFLOW_AFLOW_TEST_OUT') else RUNS/'AFlow'/phase
    SCOPE.set(('AFlow',phase,execution));folder=output/f'round-{number}'/f'pass-{repeat}';folder.mkdir(parents=True,exist_ok=True)
    path=folder/(hashlib.sha256(task['id'].encode()).hexdigest()+'.json')
    if path.exists():return json.loads(path.read_text())
    from scripts.async_llm import LLMConfig
    config=LLMConfig({'model':PROTOCOL['model'],'key':'local-ditto-bridge','base_url':endpoint()+'/v1'})
    checkpoint=benchmark_rpc('start',task);restored=checkpoint['checkpoint'];answer=checkpoint.get('answer','')
    if not restored:
        agent=load(number)(name=DATASET,llm_config=config,dataset=DATASET)
        # Guard synchronous generated Python between awaits, not model/tool duration.
        import time
        last=time.monotonic();lines=0
        def guard(frame,event,arg):
            nonlocal last,lines
            if event=='line' and frame.f_code.co_filename.endswith('/graph.py'):
                now=time.monotonic()
                if now-last>.25:lines=0
                lines+=1;last=now
                if lines>10000:raise RuntimeError('Generated workflow made no asynchronous progress')
            return guard
        sys.settrace(guard)
        try:answer,_=asyncio.run(agent(task['prompt']))
        except TransportFailure:raise
        except Exception as error:save_row(output/'errors.jsonl',{'taskId':task['id'],'round':number,'repeat':repeat,'error':repr(error)})
        finally:sys.settrace(None)
    scored=benchmark_rpc('finish',task,answer=answer)
    row={'taskId':task['id'],'round':number,'repeat':repeat,**scored,'answer':answer,'tokens':usage('AFlow',phase,execution)}
    path.with_suffix('.tmp').write_text(json.dumps(row)+'\n');path.with_suffix('.tmp').replace(path)
    save_row(output/'results.jsonl',row);print(json.dumps({k:row[k] for k in ('taskId','round','repeat','score','tokens')}),flush=True)
    return row

async def evaluate_static(number,repeat,strategy,concurrency,phase='search'):
    rows=tasks('search' if phase=='search' else 'test');gate=asyncio.Semaphore(concurrency)
    failure=None
    async def run(task):
        nonlocal failure
        async with gate:
            if failure is not None:raise failure
            try:return await asyncio.to_thread(episode,number,repeat,phase,task)
            except (TransportFailure,Exception) as error:
                failure=error;raise
    results=await asyncio.gather(*(run(t) for t in rows),return_exceptions=True)
    if failure is not None:raise failure
    return {'score':sum(r['score'] for r in results)/len(results),'meanPartialCredit':sum(r['partialCredit'] for r in results)/len(results),'meanTokens':sum(r['tokens'] for r in results)/len(results),'tokens':sum(r['tokens'] for r in results),
            'organizationSummary':{'staticWorkflow':number,'evaluated':len(results)},
            'failures':[{'taskId':r['taskId'],'question':t['prompt'],'prediction':r['answer'],'partialCredit':r['partialCredit'],**({'referenceAnswer':t['answer']} if DATASET=='HLE' and phase=='search' else {})} for r,t in zip(results,rows) if not r['score']]}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--test-round',type=int);parser.add_argument('--test-out',type=Path);args=parser.parse_args()
    if (args.test_round is None)!=(args.test_out is None):parser.error('--test-round and --test-out must be supplied together')
    if args.test_round is not None and args.test_round<1:parser.error('Invalid round')
    if args.test_round is None:
        sys.argv=['scripts/aflow_strategy.py',endpoint(),str(SOURCES/'AFlow'),str(RUNS/'AFlow')]
        SCOPE.set(('AFlow','search','optimizer'))
        runpy.run_path(str(ROOT/'scripts/aflow_strategy.py'),run_name='__main__')
    else:
        activate(RUNS/'AFlow',SOURCES/'AFlow')
        os.environ['MFLOW_AFLOW_TEST_OUT']=str(args.test_out)
        os.environ['MFLOW_BASELINE_EXECUTION_NAMESPACE']='observe-round/'
        freeze_run(args.test_out,'AFlow','round-test')
    frozen=json.loads((RUNS/'AFlow'/('frozen.json' if args.test_round is None else f'round-candidates/round-{args.test_round}.json')).read_text());number=frozen['round']
    for name,digest in frozen['files'].items():
        path=RUNS/f'AFlow/workspace/{DATASET}/workflows/round_{number}'/name
        if hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise RuntimeError('Frozen AFlow workflow changed')
    from scripts.async_llm import AsyncLLM
    AsyncLLM.__call__=lambda self,prompt:sample(prompt,self.sys_msg)
    result=asyncio.run(evaluate_static(number,0,{},PROTOCOL['concurrency'],phase='test'))
    output=args.test_out or RUNS/'AFlow/test'
    (output/'summary.json').write_text(json.dumps({'method':'AFlow','count':len(tasks('test')),'passRate':result['score'],'meanPartialCredit':result['meanPartialCredit'],'tokens':result['tokens'],'selectedRound':number,'purpose':'observation-only' if args.test_round else 'final-selected-by-search'},indent=2)+'\n')

if __name__=='__main__':
    # The controller imports this module too. Share one stage ContextVar for search and final test.
    from automation_aflow import main
    main()
