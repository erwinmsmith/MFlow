import argparse, asyncio, contextlib, json, os, random, sys, time
from bench_common import ROOT, RUNS, SCOPE, BudgetStop, tasks, grade, save_row, usage, freeze_run
p=argparse.ArgumentParser();p.add_argument('method',choices=['DyLAN','EvoAgent','AutoAgents']);p.add_argument('--phase',choices=['pilot','test'],required=True);p.add_argument('--limit',type=int);a=p.parse_args()
if a.phase=='test' and a.limit:p.error('Official test must use all 486 tasks')
random.seed(42)
if a.method=='DyLAN':
    from dylan import DyLAN
    method=DyLAN()
elif a.method=='EvoAgent':
    from evoagent import EvoAgent
    method=EvoAgent()
else:
    from autoagents_adapter import AutoAgents
    method=AutoAgents()
rows=tasks('search' if a.phase=='pilot' else 'test');rows=rows[:a.limit] if a.limit else rows
out=RUNS/a.method/a.phase;out.mkdir(parents=True,exist_ok=True);result=out/'results.jsonl'
freeze_run(out,a.method,a.phase)
done={r['taskId'] for r in map(json.loads,result.read_text().splitlines())} if result.exists() else set()
for t in rows:
    if t['id'] in done:continue
    SCOPE.set((a.method,a.phase,t['id']));started=time.monotonic();status='completed';answer=''
    try:
        with (out/'execution.log').open('a') as stream,contextlib.redirect_stdout(stream),contextlib.redirect_stderr(stream):answer=method.solve(t['prompt'])
    except BudgetStop as e:
        status=e.reason
        if 'GLOBAL_BUDGET' in status or 'SEARCH_BUDGET' in status:print(status,flush=True);sys.exit(2)
        answer=method.final()
    except Exception as e:
        save_row(out/'errors.jsonl',{'taskId':t['id'],'error':repr(e),'tokens':usage(a.method,a.phase,t['id'])});raise
    row={'taskId':t['id'],'score':grade(t,answer),'answer':answer,'status':status,'tokens':usage(a.method,a.phase,t['id']),'seconds':time.monotonic()-started}
    save_row(result,row);print(json.dumps({k:row[k] for k in ['taskId','score','status','tokens']}),flush=True)
all_rows=[json.loads(s) for s in result.read_text().splitlines()]
(out/'summary.json').write_text(json.dumps({'method':a.method,'phase':a.phase,'count':len(all_rows),'correct':sum(r['score'] for r in all_rows),'tokens':sum(r['tokens'] for r in all_rows)},indent=2)+'\n')
