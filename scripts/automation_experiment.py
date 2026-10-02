"""Run all five complete methods from an immutable code snapshot. No token cap."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[1]

def read(path,default=None):
    return json.loads(path.read_text()) if path.exists() else default

def jsonl(path):
    with path.open() as stream:
        for line in stream:
            if line.endswith('\n') and line.strip():yield json.loads(line)

def available_memory_mib():
    path=Path('/proc/meminfo')
    if path.exists():return next(int(line.split()[1])//1024 for line in path.read_text().splitlines() if line.startswith('MemAvailable:'))
    # macOS reports free and reclaimable pages rather than Linux MemAvailable.
    output=subprocess.check_output(['vm_stat'],text=True)
    pages=sum(int(line.split(':')[1].strip().rstrip('.')) for line in output.splitlines()
              if line.split(':')[0] in ('Pages free','Pages inactive','Pages speculative','Pages purgeable'))
    return pages*os.sysconf('SC_PAGE_SIZE')//(1024*1024)

def cost(records):
    result={'knownTokens':0,'unknownCalls':0}
    for row in records:
        if row['status']=='known':result['knownTokens']+=row['charged']
        else:result['unknownCalls']+=1
        if row.get('scope',{}).get('label')=='hle-judge':
            field='judgeTokens' if row['status']=='known' else 'unknownJudgeCalls';result[field]=result.get(field,0)+(row['charged'] if row['status']=='known' else 1)
    return result

def status(out):
    jobs=read(out/'jobs.json',{})
    manifest=read(out/'experiment-manifest.json',{})
    planned=manifest.get('searchCount',119 if manifest.get('benchmark')=='math' else 200)
    report={'run':str(out),'protocol':{k:manifest[k] for k in ('benchmark','model','datasetProtocol','searchCount','testCount','judgeModel','toolProtocol') if k in manifest},'jobs':jobs.get('jobs',{}),'methods':{}}
    overrides=read(out/'method-outputs.json',{})
    recovery=read(out/'recovery.json')
    if recovery:report['recovery']=recovery
    for method in ('MFlow','AFlow','DyLAN','EvoAgent','AutoAgents'):
        override=overrides.get(method,{})
        folder=Path(override['output']) if override else out/method;entry={}
        if override:entry['replacement']=override
        controller=read(folder/('search/controller.json' if method=='MFlow' else 'controller.json'),{})
        entry.update({k:controller[k] for k in ('round','phase','stopReason','seedRound') if k in controller})
        frozen=read(folder/('search/summary.json' if method=='MFlow' else 'frozen.json'),{})
        entry['frozen']={k:v for k,v in frozen.items() if k in ('round','selectedRound','validationAccuracy','validationScore','stopReason')}
        if method in ('MFlow','AFlow'):
            entry['roundTests']=[]
            for candidate in sorted((folder/('search/round-candidates' if method=='MFlow' else 'round-candidates')).glob('round-*.json'),key=lambda p:int(p.stem.split('-')[-1])):
                directory=folder/'round-tests'/candidate.stem
                summary=read(directory/'summary.json',{})
                rows=list(jsonl(directory/('test.jsonl' if method=='MFlow' else 'results.jsonl'))) if (directory/('test.jsonl' if method=='MFlow' else 'results.jsonl')).exists() else []
                entry['roundTests'].append({'round':int(candidate.stem.split('-')[-1]),'status':'completed' if summary else jobs.get('jobs',{}).get(f'{method}/round-tests/{candidate.stem}',{}).get('status','queued'),
                    'completed':summary.get('count',len(rows)),'accuracy':summary.get('accuracy',summary.get('passRate',sum(r['score'] for r in rows)/len(rows) if rows else None)),
                    'output':str(directory),'purpose':'observation-only'})
        if method=='MFlow':
            entry['cost']={}
            for phase in ('search','test'):
                files=(folder/phase).glob('round-*/pass-*/*.usage.json') if phase=='search' else (folder/phase/'task-usage').glob('*.json')
                entry['cost'][phase]=cost(r for path in files for r in read(path,[]))
            entry['cost']['roundTests']=cost(r for path in (folder/'round-tests').glob('round-*/task-usage/*.json') for r in read(path,[]))
            entry['cost']['optimizer']=cost(r for path in (folder/'search/optimizer-calls').glob('*.json') for r in read(path,{}).get('records',[]))
            passes=sorted((folder/'search').glob('round-*/pass-*'),key=lambda p:(int(p.parent.name.split('-')[-1]),int(p.name.split('-')[-1])))
            if passes:
                current=passes[-1];rows=[read(p) for p in current.glob('*.json') if p.stem.isdigit()]
                entry['currentValidation']={'round':current.parent.name,'pass':current.name,'completed':len(rows),'planned':planned,'correct':sum(r['score'] for r in rows)}
        for phase in ('pilot','search','test'):
            file=folder/phase/('test.jsonl' if method=='MFlow' else 'results.jsonl')
            if file.exists():
                totals={'evaluations':0,'correct':0,'tokens':0};partial=0
                for row in jsonl(file):
                    totals['evaluations']+=1;totals['correct']+=row['score'];totals['tokens']+=row.get('tokens',row.get('execution',{}).get('tokens',0));partial+=row.get('partialCredit',0)
                    if method=='AFlow' and phase=='search':
                        current=entry.get('currentValidation',{})
                        if (current.get('round'),current.get('pass'))!=(row['round'],row.get('repeat',0)):
                            current={'round':row['round'],'pass':row.get('repeat',0),'completed':0,'planned':planned,'correct':0};entry['currentValidation']=current
                        current['completed']+=1;current['correct']+=row['score']
                if totals['evaluations']:totals.update(passRate=totals['correct']/totals['evaluations'],meanPartialCredit=partial/totals['evaluations'])
                entry[phase]=totals
            progress=read(folder/phase/'status.json')
            if progress:entry[phase+'Status']=progress
        report['methods'][method]=entry
        if override:
            entry['originalJob']=report['jobs'].get(method,{})
            progress=entry.get('testStatus',entry.get('pilotStatus',{}))
            report['jobs'][method]={'status':progress.get('status','queued'),'service':override['service'],'output':str(folder)}
            try:
                state=subprocess.run(['systemctl','--user','show',override['service'],'--property=ActiveState','--value'],capture_output=True,text=True,timeout=3,check=True).stdout.strip()
                if state:report['jobs'][method].update(serviceState=state,status='running' if state=='active' else 'failed' if state=='failed' else report['jobs'][method]['status'])
            except (OSError,subprocess.SubprocessError):pass
    try:
        with urllib.request.urlopen(os.environ.get('MFLOW_BASELINE_ENDPOINT','http://127.0.0.1:'+str(read(out/'bridge.json',{}).get('port',8197)))+'/status',timeout=3) as response:
            transport=json.load(response)
            if Path(transport['runDirectory']).name==out.name:report['baselineTransport']=transport
    except OSError:pass
    records=out/'usage.jsonl'
    if records.exists():
        report['baselineCost']={m:{'knownTokens':0,'unknownCalls':0,'phases':{}} for m in ('AFlow','DyLAN','EvoAgent','AutoAgents')}
        for row in jsonl(records):
            entry=report['baselineCost'][row['method']]
            if row.get('kind')=='hle-judge':
                field='unknownJudgeCalls' if row['unknownUsage'] else 'judgeTokens';entry[field]=entry.get(field,0)+(1 if row['unknownUsage'] else row['charged'])
            phase=entry['phases'].setdefault(row['phase'],{'knownTokens':0,'unknownCalls':0})
            if row.get('taskId','').startswith('observe-round/'):
                observed=entry.setdefault('roundTests',{'knownTokens':0,'unknownCalls':0})
                if row['unknownUsage']:observed['unknownCalls']+=1
                else:observed['knownTokens']+=row['charged']
            for item in (entry,phase):
                if row['unknownUsage']:item['unknownCalls']+=1
                else:item['knownTokens']+=row['charged']
            override=overrides.get(row['method'])
            if override and row['taskId'].startswith(override['executionNamespace']):
                selected=entry.setdefault('replacementCost',{'knownTokens':0,'unknownCalls':0})
                if row['unknownUsage']:selected['unknownCalls']+=1
                else:selected['knownTokens']+=row['charged']
    print(json.dumps(report,ensure_ascii=False,indent=2))

def main():
    p=argparse.ArgumentParser();p.add_argument('--status',action='store_true');p.add_argument('--resume',action='store_true');p.add_argument('--sequential',action='store_true');p.add_argument('--benchmark',choices=['automationbench','math','hle'],default='automationbench');p.add_argument('--run')
    p.add_argument('--concurrency',type=int,help='Concurrent MFlow/AFlow search and test episodes')
    p.add_argument('--legacy-concurrency',type=int,default=1,help='Isolated worker processes per native legacy method')
    p.add_argument('--port',type=int,help='Independent Ditto baseline bridge port');a=p.parse_args()
    if a.concurrency is not None and a.concurrency<1 or a.legacy_concurrency<1:p.error('Concurrency must be positive')
    if a.port is not None and not 1<=a.port<=65535:p.error('Invalid bridge port')
    math=a.benchmark=='math';hle=a.benchmark=='hle'
    profile='hb-baselines.json' if os.environ.get('MFLOW_MODEL')=='qwen3.5-9b' else 'hb-deepseek-baselines.json'
    protocol='configs/'+(profile if math else 'hle-baselines.json' if hle else 'automationbench-baselines.json')
    config=read(ROOT/protocol)
    a.run=a.run or config['runDirectory']
    out=ROOT/a.run
    if a.status:status(out);return
    if os.environ.get('MFLOW_MODEL') not in (('deepseek-flash','qwen3.5-9b') if math else ('deepseek-flash',)):raise ValueError('Select the private benchmark model profile before launch')
    search_file='configs/'+('hb-aflow-search.json' if os.environ['MFLOW_MODEL']=='qwen3.5-9b' else 'hb-deepseek-aflow-search.json') if math else f'configs/{a.benchmark}-search.json'
    search_config=read(ROOT/search_file,{})
    if a.concurrency is not None:config['concurrency']=search_config['concurrency']=a.concurrency
    config['runDirectory']=a.run
    port=str(a.port or (8199 if hle else 8198 if os.environ['MFLOW_MODEL']=='qwen3.5-9b' else 8197))
    env={**os.environ,'MFLOW_BASELINE_PROTOCOL':str(out/'baseline-config.json'),'MFLOW_BASELINE_PORT':port,'MFLOW_BASELINE_ENDPOINT':'http://127.0.0.1:'+port}
    env['BENCHMARK_HOME']=str(Path(os.environ['BENCHMARK_HOME']).resolve())
    out.mkdir(parents=True,exist_ok=True)
    if hle:
        env.update(MFLOW_HLE_PROTOCOL=config['datasetProtocol'],MFLOW_HLE_JUDGE_MODEL=config['judgeModel'],MFLOW_HLE_BLOCKED_SEARCH_LOG=str(out/'blocked-web-search.jsonl'))
    manifest={'model':env['MFLOW_MODEL'],'benchmark':a.benchmark,'schedule':'sequential' if a.sequential else 'parallel','baselineConfig':config,'searchConfig':search_config,'bridgePort':int(port),'legacyConcurrency':a.legacy_concurrency,'code':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['src','dist/src','baselines','scripts','configs','benchmark-hub','data'] for p in (ROOT/folder).glob('*') if p.is_file() and p.suffix in {'.ts','.js','.mjs','.py','.json','.sh'}},'dependencies':hashlib.sha256((ROOT/'package-lock.json').read_bytes()).hexdigest()}
    if hle:
        lock=next(v for v in read(ROOT/'data/extended-benchmarks.lock.json').values() if v['protocol']==config['datasetProtocol'])
        manifest.update(datasetProtocol=lock['protocol'],searchCount=lock['splits']['search']['count'],testCount=lock['splits']['test']['count'],judgeModel=config['judgeModel'],toolProtocol=config['toolProtocol'])
    saved=read(out/'experiment-manifest.json')
    if saved and saved!=manifest:raise RuntimeError('Immutable experiment code/config changed')
    if saved and not a.resume:raise RuntimeError('Run exists; use --resume')
    (out/'experiment-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    (out/'baseline-config.json').write_text(json.dumps(config,indent=2)+'\n')
    (out/'search-config.json').write_text(json.dumps(search_config,indent=2)+'\n')
    (out/'bridge.json').write_text(json.dumps({'port':int(port)})+'\n')
    legacy=str(ROOT.parent/'MFlow-baselines/.venv-legacy/bin/python');aflow=str(ROOT.parent/'MFlow-baselines/.venv-aflow/bin/python')
    node=['node','--env-file-if-exists=.env','dist/src/cli.js']
    search=out/'MFlow/search';test=out/'MFlow/test'
    commands={
      'MFlow':[(node+['search','--benchmark',a.benchmark,'--config',str(out/'search-config.json'),'--out',str(search),'--source',str(ROOT.parent/'MFlow-baselines/sources/AFlow'),'--python',aflow]+(['--resume'] if (search/'manifest.json').exists() else [])),
               (node+['evaluate','--benchmark',a.benchmark,'--bundle',str(search/'best.json'),'--out',str(test),'--concurrency',str(config.get('concurrency',4 if env['MFLOW_MODEL']=='qwen3.5-9b' else 24))]+(['--resume'] if (test/'manifest.json').exists() else []))],
      'AFlow':[[aflow,'baselines/automation_aflow.py']],
      **{m:[[legacy,'baselines/automation_run.py',m,'--phase',phase,'--concurrency',str(a.legacy_concurrency)] for phase in ('pilot','test')] for m in ('DyLAN','EvoAgent','AutoAgents')},
    }
    if math:
        commands.update({
          'AFlow':[[aflow,'baselines/aflow.py','--phase','search-test']],
          **{m:[[legacy,'baselines/run.py',m,'--phase','test']] for m in ('DyLAN','EvoAgent','AutoAgents')},
        })
    jobs=read(out/'jobs.json',{'jobs':{}});active={};retrying={}
    def persist():
        path=out/'jobs.json';path.with_suffix('.tmp').write_text(json.dumps(jobs,indent=2)+'\n');path.with_suffix('.tmp').replace(path)
    def launch(name,index):
        if hle:
            minimum=int(os.environ.get('MFLOW_MIN_AVAILABLE_MIB','384'))
            while True:
                available=available_memory_mib()
                if available>=minimum:break
                jobs['jobs'][name]={'stage':index,'status':'waiting_for_memory','availableMiB':available,'requiredMiB':minimum};persist();time.sleep(10)
        if name!='MFlow' or not hle:start_bridge()
        (out/name if '/round-tests/' not in name else (out/name).parent).mkdir(parents=True,exist_ok=True)
        stream=(out/(name+'.log')).open('a')
        command=commands[name][index]
        if name=='MFlow' and ((search if index==0 else test)/'manifest.json').exists() and '--resume' not in command:command=command+['--resume']
        if name.startswith('MFlow/round-tests/') and (out/name/'manifest.json').exists():command=command+['--resume']
        child=subprocess.Popen(command,cwd=ROOT,env=env,stdout=stream,stderr=subprocess.STDOUT)
        stream.close();active[name]=(child,index);jobs['jobs'][name]={'pid':child.pid,'stage':index,'status':'running','startedAt':time.time()};persist()
    bridge=None
    def round_tests():
        # One full held-out round at a time per method; search continues independently.
        # No observer output is ever read by either optimizer.
        pending_rounds=False
        for method in ('MFlow','AFlow'):
            prefix=method+'/round-tests/'
            if any(name.startswith(prefix) for name in (*active,*retrying)):continue
            candidates=sorted((out/method/('search/round-candidates' if method=='MFlow' else 'round-candidates')).glob('round-*.json'),key=lambda p:int(p.stem.split('-')[-1]))
            for candidate in candidates:
                name=prefix+candidate.stem
                if (out/name/'summary.json').exists() or jobs['jobs'].get(name,{}).get('status')=='completed':continue
                pending_rounds=True
                if available_memory_mib()<int(os.environ.get('MFLOW_MIN_AVAILABLE_MIB','384')):break
                if method=='MFlow':
                    commands[name]=[node+['evaluate','--benchmark',a.benchmark,'--bundle',str(candidate),'--out',str(out/name),'--concurrency',str(config.get('concurrency',4))]]
                else:
                    commands[name]=[[aflow,*(['baselines/aflow.py','--phase','search-test'] if math else ['baselines/automation_aflow.py']),'--test-round',candidate.stem.split('-')[-1],'--test-out',str(out/name)]]
                # The evaluator creates its own output directory/immutable manifest.
                launch(name,0);break
        return pending_rounds
    def start_bridge():
        nonlocal bridge
        if bridge is not None:return
        bridge_log=(out/'bridge.log').open('a');bridge=subprocess.Popen(['node','baselines/bridge.mjs'],cwd=ROOT,env=env,stdout=bridge_log,stderr=subprocess.STDOUT);bridge_log.close()
        for attempt in range(60):
            if bridge.poll() is not None:raise RuntimeError('Bridge failed; inspect bridge.log')
            try:
                with urllib.request.urlopen(env['MFLOW_BASELINE_ENDPOINT']+'/status',timeout=1) as response:
                    remote=json.load(response)
                    if remote['runDirectory']!=a.run:raise RuntimeError('Another bridge owns this port')
                    break
            except OSError:time.sleep(1)
        else:raise RuntimeError('Bridge did not become ready')
    try:
        if not hle:start_bridge()
        pending=[name for name in commands if jobs['jobs'].get(name,{}).get('status')!='completed']
        for name in pending:jobs['jobs'][name]={'status':'queued'}
        persist()
        if a.sequential:
            if pending:launch(pending.pop(0),0)
        else:
            for name in pending:launch(name,0)
        observers_pending=round_tests()
        while active or retrying or observers_pending:
            if bridge is not None and bridge.poll() is not None:
                bridge=None;start_bridge()
            for name,(index,at) in list(retrying.items()):
                if time.monotonic()>=at:
                    if not name.startswith('MFlow'):
                        reset={'method':name.split('/')[0]}
                        if name.startswith('AFlow/round-tests/'):reset.update(phase='test',taskPrefix='observe-round/'+name.split('/')[-1]+'/')
                        elif name=='AFlow':reset.update(taskPrefix='round_' if math else 'round-')
                        request=urllib.request.Request(env['MFLOW_BASELINE_ENDPOINT']+'/reset-method',data=json.dumps(reset).encode(),headers={'Content-Type':'application/json'})
                        try:
                            with urllib.request.urlopen(request,timeout=30) as response:json.load(response)
                        except OSError as error:
                            retrying[name]=(index,time.monotonic()+60);jobs['jobs'][name].update(error=str(error),nextAttemptAt=time.time()+60);persist();continue
                    del retrying[name];launch(name,index)
            for name,(child,index) in list(active.items()):
                code=child.poll()
                if code is None:continue
                del active[name]
                if code==0 and index+1<len(commands[name]):launch(name,index+1)
                else:
                    jobs['jobs'][name].update(status='completed' if code==0 else 'failed',exitCode=code,finishedAt=time.time())
                    if code!=0 and not a.sequential:
                        retrying[name]=(index,time.monotonic()+60)
                        jobs['jobs'][name].update(status='retrying',nextAttemptAt=time.time()+60)
                    persist()
                    if a.sequential and pending:launch(pending.pop(0),0)
            observers_pending=round_tests()
            time.sleep(2)
        if any(j['status']=='failed' for j in jobs['jobs'].values()):raise RuntimeError('Some methods need repair; inspect jobs.json and logs, then --resume')
    finally:
        for child,_ in active.values():child.terminate()
        if bridge is not None:bridge.terminate();bridge.wait(timeout=15)

if __name__=='__main__':main()
