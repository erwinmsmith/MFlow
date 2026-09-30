#!/usr/bin/env python3
"""Download pinned official assets and build explicitly named MFlow views. No model calls."""
import argparse
import ast
import json
import os
import subprocess
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
    p.add_argument('--root', type=Path, default=Path(os.environ.get('BENCHMARK_HOME', Path(__file__).resolve().parents[2] / 'Benchmarks'
        if Path(__file__).parent.name == 'benchmark-hub' else Path(__file__).parent)))
    args = p.parse_args()
    print(json.dumps(prepare(args.root.resolve(), args.name), ensure_ascii=False, indent=2))
