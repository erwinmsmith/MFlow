"""Official AFlow static workflows; reuse the native search/checkpoint controller."""
import asyncio
import ast
import hashlib
import importlib.util
import json
import os
import runpy
import sys
from pathlib import Path
from bench_common import ROOT, SOURCES, RUNS, SCOPE, PROTOCOL, endpoint, tasks, call, benchmark_rpc, usage, save_row, freeze_run, TransportFailure

def prepare(out,source):
    target=out/'workspace/AutomationBench/workflows/template'
    target.mkdir(parents=True,exist_ok=True)
    for name in ['operator.py','operator_an.py','operator.json','op_prompt.py']:
        text=(source/'workspace/MATH/workflows/template'/name).read_text().replace('workspace.MATH','workspace.AutomationBench')
        if name=='op_prompt.py':text=text.replace('math problem','business workflow').replace('\\boxed{answer}','Final Summary: completed effects').replace('mathematical','workflow')
        (target/name).write_text(text)
    sys.path.insert(0,str(out))
    freeze_run(out,'AFlow','search-test')

def write_static(directory,graph,prompts,number):
    forbidden={'open','exec','eval','compile','__import__','getattr','setattr','globals','locals','vars','input','breakpoint'}
    for node in ast.walk(ast.parse(graph)):
        if isinstance(node,(ast.Import,ast.ImportFrom)) or isinstance(node,ast.Name) and (node.id in forbidden or node.id.startswith('__')):
            raise ValueError('Workflow imports and host execution are unavailable')
        if isinstance(node,ast.Attribute) and (node.attr.startswith('_') or node.attr in {'os','sys','subprocess','requests','socket','client','Programmer','create_subprocess_exec','create_subprocess_shell'}):
            raise ValueError('Workflow private/host capabilities are unavailable')
    for node in ast.parse(prompts).body:
        if not isinstance(node,ast.Assign) or not isinstance(node.value,ast.Constant) or not isinstance(node.value.value,str) or any(not isinstance(t,ast.Name) for t in node.targets):
            raise ValueError('Prompt file must define literal string constants only')
    from scripts.prompts.optimize_prompt import WORKFLOW_TEMPLATE
    (directory/'graph.py').write_text(WORKFLOW_TEMPLATE.format(graph=graph,round=number,dataset='AutomationBench'))
    (directory/'prompt.py').write_text(prompts)
    (directory/'__init__.py').write_text('')

async def sample(prompt,system):
    return await asyncio.to_thread(call,([{'role':'system','content':system}] if system else [])+[{'role':'user','content':prompt}])

def load(number):
    path=RUNS/f'AFlow/workspace/AutomationBench/workflows/round_{number}/graph.py'
    name=f'workspace.AutomationBench.workflows.round_{number}.graph'
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module.Workflow

def episode(number,repeat,phase,task):
    execution=f'round-{number}/pass-{repeat}/{task["id"]}'
    SCOPE.set(('AFlow',phase,execution));folder=RUNS/'AFlow'/phase/f'round-{number}'/f'pass-{repeat}';folder.mkdir(parents=True,exist_ok=True)
    path=folder/(hashlib.sha256(task['id'].encode()).hexdigest()+'.json')
    if path.exists():return json.loads(path.read_text())
    from scripts.async_llm import LLMConfig
    config=LLMConfig({'model':PROTOCOL['model'],'key':'local-ditto-bridge','base_url':endpoint()+'/v1'})
    restored=benchmark_rpc('start',task)['checkpoint'];answer=''
    if not restored:
        agent=load(number)(name='AutomationBench',llm_config=config,dataset='AutomationBench')
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
        except Exception as error:save_row(RUNS/'AFlow'/phase/'errors.jsonl',{'taskId':task['id'],'round':number,'repeat':repeat,'error':repr(error)})
        finally:sys.settrace(None)
    scored=benchmark_rpc('finish',task)
    row={'taskId':task['id'],'round':number,'repeat':repeat,**scored,'answer':answer,'tokens':usage('AFlow',phase,execution)}
    path.with_suffix('.tmp').write_text(json.dumps(row)+'\n');path.with_suffix('.tmp').replace(path)
    save_row(RUNS/'AFlow'/phase/'results.jsonl',row);print(json.dumps({k:row[k] for k in ('taskId','round','repeat','score','tokens')}),flush=True)
    return row

async def evaluate_static(number,repeat,strategy,concurrency,phase='search'):
    rows=tasks('search' if phase=='search' else 'test');gate=asyncio.Semaphore(concurrency)
    async def run(task):
        async with gate:return await asyncio.to_thread(episode,number,repeat,phase,task)
    results=await asyncio.gather(*(run(t) for t in rows))
    return {'score':sum(r['score'] for r in results)/len(results),'meanPartialCredit':sum(r['partialCredit'] for r in results)/len(results),'meanTokens':sum(r['tokens'] for r in results)/len(results),'tokens':sum(r['tokens'] for r in results),
            'organizationSummary':{'staticWorkflow':number,'evaluated':len(results)},
            'failures':[{'taskId':r['taskId'],'question':t['prompt'],'prediction':r['answer'],'partialCredit':r['partialCredit']} for r,t in zip(results,rows) if not r['score']]}

def main():
    sys.argv=['scripts/aflow_strategy.py',endpoint(),str(SOURCES/'AFlow'),str(RUNS/'AFlow')]
    SCOPE.set(('AFlow','search','optimizer'))
    runpy.run_path(str(ROOT/'scripts/aflow_strategy.py'),run_name='__main__')
    frozen=json.loads((RUNS/'AFlow/frozen.json').read_text());number=frozen['round']
    for name,digest in frozen['files'].items():
        path=RUNS/f'AFlow/workspace/AutomationBench/workflows/round_{number}'/name
        if hashlib.sha256(path.read_bytes()).hexdigest()!=digest:raise RuntimeError('Frozen AFlow workflow changed')
    from scripts.async_llm import AsyncLLM
    AsyncLLM.__call__=lambda self,prompt:sample(prompt,self.sys_msg)
    result=asyncio.run(evaluate_static(number,0,{},PROTOCOL['concurrency'],phase='test'))
    (RUNS/'AFlow/test/summary.json').write_text(json.dumps({'method':'AFlow','count':len(tasks('test')),'passRate':result['score'],'meanPartialCredit':result['meanPartialCredit'],'tokens':result['tokens'],'selectedRound':number},indent=2)+'\n')

if __name__=='__main__':main()
