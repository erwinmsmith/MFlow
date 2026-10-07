"""Dataset/scoring adapter and metered transport; official methods own their control flow."""
import contextvars, hashlib, importlib.metadata, json, os, subprocess, urllib.request, urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
SOURCES=ROOT.parent/'MFlow-baselines/sources'
PROTOCOL_PATH=ROOT/os.environ.get('MFLOW_BASELINE_PROTOCOL','baselines/protocol.json')
PROTOCOL=json.loads(PROTOCOL_PATH.read_text())
RUNS=ROOT/os.environ.get('MFLOW_BASELINE_RUN_DIRECTORY',PROTOCOL['runDirectory'])
SCOPE=contextvars.ContextVar('scope')
class BudgetStop(BaseException):
    def __init__(self,reason):self.reason=reason
# Native retry/format handlers catch Exception; infrastructure must escape them.
class TransportFailure(BaseException):pass
class ModelOutputFailure(RuntimeError):pass

def text_instruction():
    if PROTOCOL.get('benchmark')=='drop':
        return 'Answer using only the supplied passage and question. Resolve entities and time references, distinguish counts from totals and compare the requested quantities. Return only the concise final answer, with multiple spans separated by |; no derivation, Markdown or boxed answer. Control and ranking stages must follow their requested schema.'
    if PROTOCOL.get('benchmark')=='mbpp':
        return 'Implement the Python task with the requested function signature, imports and return type. Check boundary cases and side effects with public examples or self-created tests only. Return complete executable Python, without Markdown, explanations or boxed answers. Control and ranking stages must follow their requested schema.'
    return ''

def text_answer_key(answer):
    if PROTOCOL.get('benchmark')=='mbpp':
        import ast
        try:return ast.dump(ast.parse(answer.strip()))
        except SyntaxError:return answer.strip()
    return ' '.join(answer.casefold().split())

def endpoint():return os.environ.get('MFLOW_BASELINE_ENDPOINT',f"http://127.0.0.1:{os.environ.get('MFLOW_BASELINE_PORT','8197')}")

def bridge_request(route,body):
    req=urllib.request.Request(endpoint()+'/'+route,data=json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req,timeout=None) as response:return json.load(response)
    except urllib.error.HTTPError as e:
        error=e.read().decode()
        try:detail=json.loads(error).get('error',error)
        except (ValueError,AttributeError):detail=error
        if any(x in error for x in ['GLOBAL_BUDGET','SEARCH_BUDGET','EPISODE_BUDGET']):raise BudgetStop(error)
        if any(f'[{code}]' in detail or f'"code":"{code}"' in detail for code in ('INVALID_MODEL_OUTPUT','DEGENERATE_OUTPUT','INCOMPLETE_MODEL_OUTPUT','MODEL_CONTEXT_LIMIT','MODEL_TOOL_ERROR','MODEL_ERROR','UNDECLARED_ACTION')):raise ModelOutputFailure(error) from None
        raise TransportFailure(error) from None
    except (urllib.error.URLError,TimeoutError,ConnectionError) as error:raise TransportFailure(str(error)) from None

def execute_python(code):
    method,phase,task_id=SCOPE.get()
    return bridge_request('python',dict(method=method,phase=phase,taskId=task_id,code=code))

def call(messages,tools=True):
    method,phase,task_id=SCOPE.get()
    result=bridge_request('sample',dict(method=method,phase=phase,taskId=task_id,messages=messages,tools=tools))
    if result['finishReason']=='length':raise ModelOutputFailure('[INCOMPLETE_MODEL_OUTPUT] Provider context/output ceiling reached; response is incomplete')
    return result['message']['content']

def search_web(query):
    query=' '.join(query.split())
    if len(query)>600 or len(query.split())>75:
        query=call([{'role':'system','content':'Convert this search request to one concise search query, under 500 characters and 60 words. Return only the query; do not answer it.'},{'role':'user','content':query}],tools=False)
        query=' '.join(query.split())
    if not query or len(query)>600 or len(query.split())>75:
        raise ModelOutputFailure('[MODEL_TOOL_ERROR] Search query must be nonempty and at most 600 characters / 75 words')
    method,phase,task_id=SCOPE.get()
    return json.dumps(bridge_request('search',dict(method=method,phase=phase,taskId=task_id,query=query))['results'])

def tasks(split):
    if PROTOCOL.get('benchmark') in ('automationbench','hle'):
        home=Path(os.environ.get('BENCHMARK_HOME',ROOT.parent/'Benchmarks'))
        protocol=PROTOCOL.get('datasetProtocol','automationbench-public-simple-v1')
        path=home/f'views/{protocol}/{split}.jsonl'
        lock=json.loads((ROOT/'data/extended-benchmarks.lock.json').read_text())
        entry=next(v for v in lock.values() if v['protocol']==protocol)['splits'][split]
        if hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:raise ValueError('Pinned shared split hash mismatch')
        rows=[json.loads(s) for s in path.read_text().split('\n') if s.strip()]
        if len(rows)!=entry['count']:raise ValueError('Pinned shared split count mismatch')
        return rows
    benchmark=PROTOCOL.get('benchmark','math')
    if benchmark in ('drop','mbpp'):
        home=Path(os.environ.get('BENCHMARK_HOME',ROOT.parent/'Benchmarks')).resolve()
        record=json.loads((home/'catalog.json').read_text())['benchmarks'][benchmark]
        path=(home/record['views'][record['defaultProtocol']]['path']/f'{split}.jsonl').resolve()
        if not path.is_relative_to(home):raise ValueError('Benchmark path escapes shared home')
    else:path=ROOT/f'data/benchmarks/{benchmark}/{split}.jsonl'
    lock=json.loads((ROOT/'data/aflow.lock.json').read_text())
    entry=lock["files"][f"{benchmark}_{'validate' if split=='search' else 'test'}.jsonl"]
    if hashlib.sha256(path.read_bytes()).hexdigest()!=entry["convertedSha256"]:raise ValueError("Pinned split hash mismatch")
    rows=[json.loads(s) for s in path.read_text().split('\n') if s.strip()]
    if len(rows)!=entry["count"]:raise ValueError("Pinned split count mismatch")
    return rows

def grade(task,answer):
    if task.get('metric')=='automationbench':return benchmark_rpc('finish',task)['score']
    p=subprocess.run([str(ROOT/'.benchmark-venv/bin/python'),str(ROOT/'scripts/grade_math.py'),json.dumps({'gold':task['answer'],'answer':answer})],capture_output=True,text=True,timeout=10,check=True)
    return int(p.stdout.strip()=='1')

def usage(method,phase,task_id):
    path=Path(os.environ.get('MFLOW_BASELINE_USAGE_PATH',RUNS/'usage.jsonl'))
    if not path.exists():return 0
    with path.open() as stream:
        return sum(r['charged'] for r in map(json.loads,stream) if r['method']==method and r['phase']==f'{method}:{phase}' and r['taskId']==task_id)

def save_row(out,row):
    out.parent.mkdir(parents=True,exist_ok=True)
    import fcntl
    with out.open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX);f.write(json.dumps(row)+'\n');f.flush()

def benchmark_rpc(route,task,**fields):
    method,phase,task_id=SCOPE.get()
    return bridge_request(route,dict(method=method,phase=phase,taskId=task_id,benchmarkTaskId=task['id'],**fields))

def freeze_run(out,method,phase):
    """Refuse to mix a resumed evaluation with different code, dependencies or data."""
    files=list((ROOT/'baselines').glob('*.py'))+[ROOT/'baselines/bridge.mjs',PROTOCOL_PATH,ROOT/'baselines/sources.lock.json',ROOT/'scripts/grade_math.py',ROOT/'data/aflow.lock.json',ROOT/'package-lock.json']
    if PROTOCOL.get('benchmark')!='automationbench':files += [ROOT/'dist/src/python-tool.js',ROOT/'scripts/resume_aflow_test.py']
    if PROTOCOL.get('benchmark') in ('automationbench','hle','drop','mbpp'):files += [ROOT/'data/extended-benchmarks.lock.json',ROOT/'scripts/aflow_strategy.py',ROOT/'benchmark-hub/automation_bridge.py',*sorted((ROOT/'dist/src').glob('*.js'))]
    manifest={'method':method,'phase':phase,'protocol':PROTOCOL,'testCount':len(tasks('test')),'validationCount':len(tasks('search')),'files':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(files)}}
    manifest['transport']={'endpoint':endpoint(),'executionNamespace':os.environ.get('MFLOW_BASELINE_EXECUTION_NAMESPACE',''),'usagePath':str(Path(os.environ.get('MFLOW_BASELINE_USAGE_PATH',RUNS/'usage.jsonl')).resolve())}
    if os.environ.get('MFLOW_BASELINE_TRANSPORT_ROOT'):
        server=Path(os.environ['MFLOW_BASELINE_TRANSPORT_ROOT']).resolve()
        server_files=[server/'baselines/bridge.mjs',server/'configs/automationbench-baselines.json',server/'package-lock.json',server/'benchmark-hub/automation_bridge.py',*sorted((server/'dist/src').glob('*.js'))]
        manifest['transport'].update(root=str(server),files={str(p.relative_to(server)):hashlib.sha256(p.read_bytes()).hexdigest() for p in server_files})
    manifest['pythonPackages']=sorted(f"{p.metadata['Name']}=={p.version}" for p in importlib.metadata.distributions())
    source=json.loads((ROOT/'baselines/sources.lock.json').read_text())[method]
    for name,digest in source['files'].items():
        if hashlib.sha256((SOURCES/method/name).read_bytes()).hexdigest()!=digest:raise RuntimeError(f'Official source changed: {method}/{name}')
    out.mkdir(parents=True,exist_ok=True);path=out/'manifest.json'
    if path.exists() and json.loads(path.read_text())!=manifest:raise RuntimeError('Frozen run configuration changed; refuse resume')
    path.write_text(json.dumps(manifest,indent=2)+'\n')
