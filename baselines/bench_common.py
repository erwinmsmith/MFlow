"""Dataset/scoring adapter and metered transport; official methods own their control flow."""
import contextvars, hashlib, importlib.metadata, json, subprocess, urllib.request, urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCES=ROOT.parent/'MFlow-baselines/sources'
RUNS=ROOT/'runs/baselines-math'
SCOPE=contextvars.ContextVar('scope')
class BudgetStop(BaseException):
    def __init__(self,reason):self.reason=reason
class TransportFailure(RuntimeError):pass

def call(messages):
    method,phase,task_id=SCOPE.get()
    body=json.dumps(dict(method=method,phase=phase,taskId=task_id,messages=messages)).encode()
    req=urllib.request.Request('http://127.0.0.1:8197/sample',data=body,headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=100) as response:result=json.load(response)
    except urllib.error.HTTPError as e:
        error=e.read().decode()
        if any(x in error for x in ['GLOBAL_BUDGET','SEARCH_BUDGET','EPISODE_BUDGET']):raise BudgetStop(error)
        raise TransportFailure(error) from None
    if result['finishReason']=='length':raise BudgetStop('OUTPUT_LIMIT')
    return result['message']['content']

def tasks(split):
    path=ROOT/f'data/benchmarks/math/{split}.jsonl'
    lock=json.loads((ROOT/'data/aflow.lock.json').read_text())
    entry=lock["files"][f"math_{'validate' if split=='search' else 'test'}.jsonl"]
    if hashlib.sha256(path.read_bytes()).hexdigest()!=entry["convertedSha256"]:raise ValueError("Pinned split hash mismatch")
    rows=[json.loads(s) for s in path.read_text().splitlines()]
    if len(rows)!=entry["count"]:raise ValueError("Pinned split count mismatch")
    return rows

def grade(task,answer):
    p=subprocess.run([str(ROOT/'.benchmark-venv/bin/python'),str(ROOT/'scripts/grade_math.py'),json.dumps({'gold':task['answer'],'answer':answer})],capture_output=True,text=True,timeout=10,check=True)
    return int(p.stdout.strip()=='1')

def usage(method,phase,task_id):
    path=RUNS/'usage.jsonl'
    if not path.exists():return 0
    return sum(r['charged'] for r in map(json.loads,path.read_text().splitlines()) if r['method']==method and r['phase']==f'{method}:{phase}' and r['taskId']==task_id)

def save_row(out,row):
    out.parent.mkdir(parents=True,exist_ok=True)
    with out.open('a') as f:f.write(json.dumps(row)+'\n')

def freeze_run(out,method,phase):
    """Refuse to mix a resumed evaluation with different code, dependencies or data."""
    files=list((ROOT/'baselines').glob('*.py'))+[ROOT/'baselines/bridge.mjs',ROOT/'baselines/sources.lock.json',ROOT/'scripts/grade_math.py',ROOT/'data/aflow.lock.json',ROOT/'package-lock.json']
    manifest={'method':method,'phase':phase,'model':'deepseek-flash','temperature':0,'maxOutputTokens':4096,'episodeTokenLimit':24000,'seed':42,'testCount':486,'validationCount':119,'files':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}}
    manifest['pythonPackages']=sorted(f"{p.metadata['Name']}=={p.version}" for p in importlib.metadata.distributions())
    source=json.loads((ROOT/'baselines/sources.lock.json').read_text())[method]
    for name,digest in source['files'].items():
        if hashlib.sha256((SOURCES/method/name).read_bytes()).hexdigest()!=digest:raise RuntimeError(f'Official source changed: {method}/{name}')
    out.mkdir(parents=True,exist_ok=True);path=out/'manifest.json'
    if path.exists() and json.loads(path.read_text())!=manifest:raise RuntimeError('Frozen run configuration changed; refuse resume')
    path.write_text(json.dumps(manifest,indent=2)+'\n')
