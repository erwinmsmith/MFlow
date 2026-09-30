#!/usr/bin/env python3
"""Download pinned official assets and build explicitly named MFlow views. No model calls."""
import argparse
import ast
import base64
import hashlib
import json
import os
import subprocess
import unicodedata
from collections import defaultdict
from pathlib import Path

from bench import read, save, sha, verify, contained

SOURCES = {
    'automationbench': ('https://github.com/zapier/AutomationBench.git', '4a8e1061254004d9dac807054eed33fad7d1ff14'),
    'hle': ('https://github.com/centerforaisafety/hle.git', '22ed3074b1e7b134bcbc09028d0ba320839b0655'),
}
HLE_REVISION = '5a81a4c7271a2a2a312b9a690f0c2fde837e4c29'


def literal(file, variable):
    for node in ast.parse(file.read_text()).body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == variable for t in node.targets):
            return ast.literal_eval(node.value)
    raise ValueError(f'Missing official prompt: {variable}')


def jsonl(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    content = ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows)
    if path.exists() and path.read_text() != content:
        raise ValueError(f'Existing view changed: {path}')
    path.write_text(content, encoding='utf-8')
    return {'count': len(rows), 'sha256': sha(path)}


def hle_multimodal(root):
    """Separate full-test and custom holdout views; never relabel the official text view."""
    verify(root,'hle')
    catalog=read(root/'catalog.json');record=catalog['benchmarks']['hle']
    old=read(root/'views/hle-text-test-v1/manifest.json')
    raw=root/'collections/hle/raw/data/test-00000-of-00001.parquet'
    if sha(raw)!=old['source']['parquetSha256']:raise ValueError('Pinned HLE Parquet changed')
    # Read only public question/image and evaluator labels, not author rationales/images.
    import pyarrow.parquet as pq
    rows=[];image_files=[]
    for batch in pq.ParquetFile(raw).iter_batches(batch_size=16,columns=['id','question','image','answer','category','answer_type']):
        for r in batch.to_pylist():
            row={'id':'hle:'+r['id'],'benchmark':'hle','prompt':old['systemPrompt']+'\n\n'+r['question'],
                 'answer':r['answer'],'metric':'hle','category':r['category'],'answerType':r['answer_type']}
            if r['image']:
                header,encoded=r['image'].split(',',1)
                mime=header.removeprefix('data:').removesuffix(';base64')
                if mime not in ['image/png','image/jpeg','image/gif','image/webp']:raise ValueError('Unsupported HLE image')
                content=base64.b64decode(encoded,validate=True);digest=hashlib.sha256(content).hexdigest()
                file=root/f'collections/hle/images/{digest}.bin';file.parent.mkdir(parents=True,exist_ok=True)
                if file.exists() and file.read_bytes()!=content:raise ValueError('HLE image changed')
                file.write_bytes(content);image_files.append(file)
                row['images']=[{'path':str(file.relative_to(root)),'sha256':digest,'mimeType':mime}]
            key=' '.join(unicodedata.normalize('NFKC',r['question']).split()).lower()+'\n'+','.join(i['sha256'] for i in row.get('images',[]))
            row['group']='hle:'+hashlib.sha256(key.encode()).hexdigest();rows.append(row)
    if len(rows)!=2500 or sum(bool(r.get('images')) for r in rows)!=342:raise ValueError('Pinned HLE full counts changed')
    if len({r['group'] for r in rows})!=2500:raise ValueError('Duplicate question/image groups need a grouped split')
    # Largest remainder allocation across subject, answer type and modality, seed 42.
    strata=defaultdict(list)
    for r in rows:strata[(r['category'],r['answerType'],bool(r.get('images')))].append(r)
    quotas={k:len(v)*200//2500 for k,v in strata.items()}
    for k in sorted(strata,key=lambda k:(-(len(strata[k])*200%2500),k))[:200-sum(quotas.values())]:quotas[k]+=1
    selected={r['id'] for k,v in strata.items() for r in sorted(v,key=lambda r:hashlib.sha256(('42:'+r['id']).encode()).hexdigest())[:quotas[k]]}
    outputs={};managed=list(image_files)
    for key,protocol,splits in [('hle_full','hle-full-test-v1',{'test':rows}),
         ('hle_holdout','hle-full-holdout-v1',{'search':[r for r in rows if r['id'] in selected],'test':[r for r in rows if r['id'] not in selected]})]:
        view=root/'views'/protocol;lock={**old,'protocol':protocol,'splits':{},'scope':'Official 2500-question test' if key=='hle_full' else 'Custom stratified 200/2300 holdout; not official full-test accuracy'}
        if key=='hle_holdout':lock['splitMethod']={'seed':42,'searchCount':200,'stratification':['category','answerType','hasImage'],'allocation':'largest remainder; SHA256(42:taskId) order'}
        for split,tasks in splits.items():
            tasks=[{**r,'dataset':{'protocol':protocol,'split':split}} for r in tasks]
            lock['splits'][split]={**jsonl(view/(split+'.jsonl'),tasks),'imageCount':sum(bool(r.get('images')) for r in tasks)}
        save(view/'manifest.json',lock);outputs[key]=lock
        record['views'][protocol]={'path':str(view.relative_to(root)),'format':'mflow-jsonl','runtime':'ready',**{s+'Count':v['count'] for s,v in lock['splits'].items()}}
        managed.extend(view.iterdir())
    record['scope']='Pinned official full/test-only views and a separately named custom stratified search/test holdout; question images only'
    files=read(root/catalog['fileManifest'])
    for file in managed:files[str(file.relative_to(root))]={'sha256':sha(file),'bytes':file.stat().st_size}
    save(root/catalog['fileManifest'],files);save(root/'catalog.json',catalog)
    return outputs


def prepare(root, benchmark):
    # Verify the old baseline before adding assets, never silently rebase hashes.
    if (root / 'catalog.json').exists():
        verify(root)
    folder = root / 'collections' / benchmark
    official = folder / 'official'
    contained(root, str(folder.relative_to(root)))
    url, revision = SOURCES[benchmark]
    if not official.exists():
        subprocess.run(['git', 'clone', url, str(official)], check=True)
        subprocess.run(['git', '-C', str(official), 'checkout', '--detach', revision], check=True)
    if subprocess.check_output(['git', '-C', str(official), 'rev-parse', 'HEAD'], text=True).strip() != revision:
        raise ValueError('Official checkout revision mismatch')
    protocol = 'automationbench-public-simple-v1' if benchmark == 'automationbench' else 'hle-text-test-v1'
    view = root / 'views' / protocol
    lock = {'protocol': protocol, 'source': {'url': url, 'revision': revision}, 'splits': {}}
    runtime = 'ready'
    if benchmark == 'automationbench':
        subprocess.run(['uv', 'sync', '--locked', '--no-dev', '--project', str(official)], check=True)
        python = official / '.venv/bin/python'
        # Task builders and environment setup are official; no official model runner is invoked.
        subprocess.run([str(python), str(Path(__file__).with_name('automation_bridge.py')), '--export', str(folder / 'tasks.jsonl')], check=True)
        tasks = [json.loads(line) for line in (folder / 'tasks.jsonl').read_text().splitlines()]
        for split in ('search', 'test'):
            rows = []
            for r in tasks:
                simple = r['info']['task_name'].startswith('simple.')
                if simple != (split == 'search'):
                    continue
                rows.append({'id': 'automationbench:' + r['info']['task_name'], 'benchmark': benchmark,
                    'prompt': '\n\n'.join(m['role'].upper() + ': ' + m['content'] for m in r['prompt']),
                    'answer': '', 'metric': 'automationbench', 'dataset': {'protocol': protocol, 'split': split},
                    'reference': {'automationTaskId': r['info']['task_name']}, 'group': r['info']['task_name']})
            lock['splits'][split] = jsonl(view / (split + '.jsonl'), rows)
        lock['toolset'] = 'api'
        lock['source']['uvLockSha256'] = sha(official / 'uv.lock')
    else:
        lock['source']['dataset'] = 'cais/hle'
        lock['source']['datasetRevision'] = HLE_REVISION
        lock['judgePrompt'] = literal(official / 'hle_eval/run_judge_results.py', 'JUDGE_PROMPT')
        lock['systemPrompt'] = literal(official / 'hle_eval/run_model_predictions.py', 'SYSTEM_PROMPT')
        # Existing official runtime supplies HF and Parquet libraries; shared download cache.
        python = root / 'collections/automationbench/official/.venv/bin/python'
        script = '''
import json,sys
from huggingface_hub import hf_hub_download
from huggingface_hub.errors import GatedRepoError
try:
    for f in ['README.md','eval.yaml','data/test-00000-of-00001.parquet']:
        hf_hub_download('cais/hle',f,repo_type='dataset',revision=sys.argv[1],local_dir=sys.argv[2])
except Exception as e:
    if not isinstance(e,GatedRepoError) and not any(getattr(getattr(x,'response',None),'status_code',None)==403 for x in [e,e.__cause__,e.__context__]):raise
    print('HLE_ACCESS_PENDING');sys.exit(3)
'''
        result = subprocess.CompletedProcess([], 0) if (folder / 'raw/data/test-00000-of-00001.parquet').exists() else subprocess.run(
            [str(python), '-c', script, HLE_REVISION, str(folder / 'raw')])
        if result.returncode == 3:
            runtime = 'access-pending'
        elif result.returncode:
            raise RuntimeError('HLE download failed')
        else:
            script = '''
import json,sys,pyarrow.parquet as pq
rows=pq.read_table(sys.argv[1]).to_pylist()
print(json.dumps([{'id': 'hle:'+r['id'], 'benchmark':'hle', 'prompt':sys.argv[2]+'\\n\\n'+r['question'],
'answer':r['answer'], 'metric':'hle', 'dataset':{'protocol':'hle-text-test-v1','split':'test'},
'group':'hle:'+r['id']} for r in rows if not r['image']]))
'''
            rows = json.loads(subprocess.check_output([str(python), '-c', script,
                str(folder / 'raw/data/test-00000-of-00001.parquet'), lock['systemPrompt']], text=True))
            if len(rows) != 2158:
                raise ValueError('Pinned HLE text subset count changed')
            lock['splits']['test'] = jsonl(view / 'test.jsonl', rows)
            lock['source']['parquetSha256'] = sha(folder / 'raw/data/test-00000-of-00001.parquet')
    view.mkdir(parents=True, exist_ok=True)
    save(view / 'manifest.json', lock)
    catalog = read(root / 'catalog.json')
    files = read(root / catalog['fileManifest'])
    for directory in (folder, view):
        for file in sorted(directory.rglob('*')):
            if not file.is_file() or any(p in file.parts for p in ('.git', '.venv', '__pycache__', '.cache')):
                continue
            if file.name == '.env':
                raise ValueError('Credentials must not enter benchmark assets')
            files[str(file.relative_to(root))] = {'sha256': sha(file), 'bytes': file.stat().st_size}
    save(root / catalog['fileManifest'], files)
    catalog['benchmarks'][benchmark] = {'raw': str(folder.relative_to(root)), 'source': lock['source'],
        'runtime': runtime, 'defaultProtocol': protocol, 'views': {protocol: {
            'path': str(view.relative_to(root)), 'format': 'mflow-jsonl', 'runtime': runtime,
            **{s + 'Count': v['count'] for s, v in lock['splits'].items()}}},
        'scope': 'Public simple tasks for search; six public domains for test; not the private leaderboard' if benchmark == 'automationbench'
                 else 'Official test, text-only view; no search split; original multimodal Parquet retained when access granted'}
    save(root / 'catalog.json', catalog)
    return lock


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('name', choices=('hle', 'automationbench'))
    p.add_argument('--multimodal',action='store_true',help='Build all-image HLE full-test and independent custom holdout views')
    p.add_argument('--root', type=Path, default=Path(os.environ.get('BENCHMARK_HOME', Path(__file__).resolve().parents[2] / 'Benchmarks'
        if Path(__file__).parent.name == 'benchmark-hub' else Path(__file__).parent)))
    args = p.parse_args()
    if args.multimodal and args.name!='hle':p.error('--multimodal requires hle')
    print(json.dumps(hle_multimodal(args.root.resolve()) if args.multimodal else prepare(args.root.resolve(), args.name), ensure_ascii=False, indent=2))
