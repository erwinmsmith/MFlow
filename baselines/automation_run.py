"""Independent official-framework episodes in isolated processes; bounded by RAM, not tokens."""
import argparse
import concurrent.futures as futures
import contextlib
import json
import os
import time
from bench_common import RUNS, SCOPE, tasks, freeze_run, benchmark_rpc, usage, save_row, TransportFailure

method = None
def initialize(name):
    global method
    if name == 'DyLAN':
        from dylan import DyLAN
        method = DyLAN()
    elif name == 'EvoAgent':
        from evoagent import EvoAgent
        method = EvoAgent()
    else:
        from autoagents_adapter import AutoAgents
        method = AutoAgents()

def episode(name, phase, task):
    execution_id=os.environ.get('MFLOW_BASELINE_EXECUTION_NAMESPACE','')+task['id']
    SCOPE.set((name,phase,execution_id))
    started=time.monotonic();out=RUNS/name/phase;status='completed';answer=''
    checkpoint=benchmark_rpc('start',task);restored=checkpoint['checkpoint'];answer=checkpoint.get('answer','')
    if not restored:
        try:
            with (out/(task['id'].replace('/','-')+'.log')).open('a') as stream,contextlib.redirect_stdout(stream),contextlib.redirect_stderr(stream):
                answer=method.solve(task['prompt'])
        except TransportFailure:raise
        except Exception as error:
            status='execution_error';save_row(out/'errors.jsonl',{'taskId':task['id'],'error':repr(error)})
    grade=benchmark_rpc('finish',task,answer=answer)
    row={'taskId':task['id'],**grade,'answer':answer,'status':status,'checkpointRecovered':restored,
         'tokens':usage(name,phase,execution_id),'seconds':time.monotonic()-started}
    save_row(out/'results.jsonl',row)
    return row

def main():
    p=argparse.ArgumentParser();p.add_argument('method',choices=['DyLAN','EvoAgent','AutoAgents']);p.add_argument('--phase',choices=['pilot','test'],required=True);p.add_argument('--concurrency',type=int,default=2);a=p.parse_args()
    if a.concurrency<1:p.error('Concurrency must be positive')
    out=RUNS/a.method/a.phase;freeze_run(out,a.method,a.phase)
    selected=tasks('search' if a.phase=='pilot' else 'test')
    results=out/'results.jsonl';rows=[json.loads(s) for s in results.read_text().splitlines()] if results.exists() else []
    done={r['taskId'] for r in rows}
    if len(done)!=len(rows) or not done<={t['id'] for t in selected}:raise ValueError('Invalid completed results')
    remaining=iter(t for t in selected if t['id'] not in done);failed=False
    def status(state):
        path=out/'status.json';path.with_suffix('.tmp').write_text(json.dumps({'status':state,'completed':len(rows),'planned':len(selected),'concurrency':a.concurrency,'updatedAt':time.time()})+'\n');path.with_suffix('.tmp').replace(path)
    status('running')
    with futures.ProcessPoolExecutor(max_workers=a.concurrency,initializer=initialize,initargs=(a.method,)) as pool:
        pending={}
        def submit():
            task=next(remaining,None)
            if task:pending[pool.submit(episode,a.method,a.phase,task)]=task
        for _ in range(a.concurrency):submit()
        while pending:
            finished,_=futures.wait(pending,return_when=futures.FIRST_COMPLETED)
            for future in finished:
                task=pending.pop(future)
                try:
                    row=future.result();rows.append(row);print(json.dumps({k:row[k] for k in ('taskId','score','partialCredit','tokens')}),flush=True)
                except (TransportFailure,Exception) as error:
                    failed=True;save_row(out/'errors.jsonl',{'taskId':task['id'],'error':repr(error)})
                if not failed:submit()
                status('incomplete' if failed else 'running')
    if failed:raise RuntimeError('Infrastructure failure; fix and resume the saved run')
    status('completed')
    (out/'summary.json').write_text(json.dumps({'method':a.method,'count':len(rows),'correct':sum(r['score'] for r in rows),'passRate':sum(r['score'] for r in rows)/len(rows),'meanPartialCredit':sum(r['partialCredit'] for r in rows)/len(rows),'tokens':sum(r['tokens'] for r in rows)},indent=2)+'\n')

if __name__=='__main__':main()
