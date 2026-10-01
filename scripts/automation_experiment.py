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
        if method=='MFlow':
            entry['cost']={}
            for phase in ('search','test'):
                files=(folder/phase).glob('round-*/pass-*/*.usage.json') if phase=='search' else (folder/phase/'task-usage').glob('*.json')
                entry['cost'][phase]=cost(r for path in files for r in read(path,[]))
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
    p=argparse.ArgumentParser();p.add_argument('--status',action='store_true');p.add_argument('--resume',action='store_true');p.add_argument('--sequential',action='store_true');p.add_argument('--benchmark',choices=['automationbench','math','hle'],default='automationbench');p.add_argument('--run');a=p.parse_args()
    math=a.benchmark=='math';hle=a.benchmark=='hle'
    profile='hb-baselines.json' if os.environ.get('MFLOW_MODEL')=='qwen3.5-9b' else 'hb-deepseek-baselines.json'
    protocol='configs/'+(profile if math else 'hle-baselines.json' if hle else 'automationbench-baselines.json')
    config=read(ROOT/protocol)
    a.run=a.run or config['runDirectory']
    out=ROOT/a.run
    if a.status:status(out);return
    if os.environ.get('MFLOW_MODEL') not in (('deepseek-flash','qwen3.5-9b') if math else ('deepseek-flash',)):raise ValueError('Select the private benchmark model profile before launch')
    port='8199' if hle else '8198' if os.environ['MFLOW_MODEL']=='qwen3.5-9b' else '8197'
    env={**os.environ,'MFLOW_BASELINE_PROTOCOL':protocol,'MFLOW_BASELINE_PORT':port,'MFLOW_BASELINE_ENDPOINT':'http://127.0.0.1:'+port}
    env['BENCHMARK_HOME']=str(Path(os.environ['BENCHMARK_HOME']).resolve())
    out.mkdir(parents=True,exist_ok=True)
    if hle:
        env.update(MFLOW_HLE_PROTOCOL=config['datasetProtocol'],MFLOW_HLE_JUDGE_MODEL=config['judgeModel'],MFLOW_HLE_BLOCKED_SEARCH_LOG=str(out/'blocked-web-search.jsonl'))
    manifest={'model':env['MFLOW_MODEL'],'benchmark':a.benchmark,'schedule':'sequential' if a.sequential else 'parallel','code':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for folder in ['src','dist/src','baselines','scripts','configs','benchmark-hub','data'] for p in (ROOT/folder).glob('*') if p.is_file() and p.suffix in {'.ts','.js','.mjs','.py','.json','.sh'}},'dependencies':hashlib.sha256((ROOT/'package-lock.json').read_bytes()).hexdigest()}
    if hle:
        lock=next(v for v in read(ROOT/'data/extended-benchmarks.lock.json').values() if v['protocol']==config['datasetProtocol'])
        manifest.update(datasetProtocol=lock['protocol'],searchCount=lock['splits']['search']['count'],testCount=lock['splits']['test']['count'],judgeModel=config['judgeModel'],toolProtocol=config['toolProtocol'])
    saved=read(out/'experiment-manifest.json')
    if saved and saved!=manifest:raise RuntimeError('Immutable experiment code/config changed')
    if saved and not a.resume:raise RuntimeError('Run exists; use --resume')
    (out/'experiment-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    legacy=str(ROOT.parent/'MFlow-baselines/.venv-legacy/bin/python');aflow=str(ROOT.parent/'MFlow-baselines/.venv-aflow/bin/python')
    node=['node','--env-file-if-exists=.env','dist/src/cli.js']
    search=out/'MFlow/search';test=out/'MFlow/test'
    commands={
      'MFlow':[(node+['search','--benchmark','automationbench','--config','configs/automationbench-search.json','--out',str(search),'--source',str(ROOT.parent/'MFlow-baselines/sources/AFlow'),'--python',aflow]+(['--resume'] if (search/'manifest.json').exists() else [])),
               (node+['evaluate','--benchmark','automationbench','--bundle',str(search/'best.json'),'--out',str(test),'--concurrency',str(config['concurrency'])]+(['--resume'] if (test/'manifest.json').exists() else []))],
      'AFlow':[[aflow,'baselines/automation_aflow.py']],
      **{m:[[legacy,'baselines/automation_run.py',m,'--phase',phase,'--concurrency','1'] for phase in ('pilot','test')] for m in ('DyLAN','EvoAgent','AutoAgents')},
    }
    if math:
        commands={
          'MFlow':[(node+['search','--benchmark','math','--config','configs/hb-aflow-search.json' if env['MFLOW_MODEL']=='qwen3.5-9b' else 'configs/hb-deepseek-aflow-search.json','--out',str(search),'--source',str(ROOT.parent/'MFlow-baselines/sources/AFlow'),'--python',aflow]+(['--resume'] if (search/'manifest.json').exists() else [])),
                   (node+['evaluate','--benchmark','math','--bundle',str(search/'best.json'),'--out',str(test),'--concurrency','4' if env['MFLOW_MODEL']=='qwen3.5-9b' else '24']+(['--resume'] if (test/'manifest.json').exists() else []))],
          'AFlow':[[aflow,'baselines/aflow.py','--phase','search-test']],
          **{m:[[legacy,'baselines/run.py',m,'--phase','test']] for m in ('DyLAN','EvoAgent','AutoAgents')},
        }
    if hle:
        commands={
          'MFlow':[(node+['search','--benchmark','hle','--config','configs/hle-search.json','--out',str(search),'--source',str(ROOT.parent/'MFlow-baselines/sources/AFlow'),'--python',aflow]+(['--resume'] if (search/'manifest.json').exists() else [])),
                   (node+['evaluate','--benchmark','hle','--bundle',str(search/'best.json'),'--out',str(test),'--concurrency',str(config['concurrency'])]+(['--resume'] if (test/'manifest.json').exists() else []))],
          'AFlow':[[aflow,'baselines/automation_aflow.py']],
          **{m:[[legacy,'baselines/automation_run.py',m,'--phase',phase,'--concurrency','1'] for phase in ('pilot','test')] for m in ('DyLAN','EvoAgent','AutoAgents')},
        }
    jobs=read(out/'jobs.json',{'jobs':{}});active={}
    def persist():
        path=out/'jobs.json';path.with_suffix('.tmp').write_text(json.dumps(jobs,indent=2)+'\n');path.with_suffix('.tmp').replace(path)
    def launch(name,index):
        if hle:
            minimum=int(os.environ.get('MFLOW_MIN_AVAILABLE_MIB','384'))
            while True:
                available=next(int(line.split()[1])//1024 for line in Path('/proc/meminfo').read_text().splitlines() if line.startswith('MemAvailable:'))
                if available>=minimum:break
                jobs['jobs'][name]={'stage':index,'status':'waiting_for_memory','availableMiB':available,'requiredMiB':minimum};persist();time.sleep(10)
        if name!='MFlow' or not hle:start_bridge()
        (out/name).mkdir(parents=True,exist_ok=True)
        stream=(out/(name+'.log')).open('a')
        child=subprocess.Popen(commands[name][index],cwd=ROOT,env=env,stdout=stream,stderr=subprocess.STDOUT)
        stream.close();active[name]=(child,index);jobs['jobs'][name]={'pid':child.pid,'stage':index,'status':'running','startedAt':time.time()};persist()
    bridge=None
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
        while active:
            for name,(child,index) in list(active.items()):
                code=child.poll()
                if code is None:continue
                del active[name]
                if code==0 and index+1<len(commands[name]):launch(name,index+1)
                else:
                    jobs['jobs'][name].update(status='completed' if code==0 else 'failed',exitCode=code,finishedAt=time.time());persist()
                    if a.sequential and pending:launch(pending.pop(0),0)
            time.sleep(2)
        if any(j['status']=='failed' for j in jobs['jobs'].values()):raise RuntimeError('Some methods need repair; inspect jobs.json and logs, then --resume')
    finally:
        for child,_ in active.values():child.terminate()
        if bridge is not None:bridge.terminate();bridge.wait(timeout=15)

if __name__=='__main__':main()
