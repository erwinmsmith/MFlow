#!/usr/bin/env python3
"""Inspect, verify, and materialize MFlow splits without Node, Ditto, or model calls."""
import argparse
import base64
import gzip
import hashlib
import importlib.util
import json
import subprocess
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def checked(path, expected):
    data = path.read_bytes()
    if sha(data) != expected:
        raise ValueError(f'SHA-256 mismatch: {path}')
    return json.loads(data)


def load(benchmark, protocol=None, root=HERE):
    entries = [e for e in read(root / 'catalog.json')['entries'] if e['benchmark'] == benchmark and (protocol is None or e['protocol'] == protocol)]
    if len(entries) != 1:
        raise ValueError('Select one published protocol explicitly; HLE has three distinct protocols.')
    entry = entries[0]
    path = root / entry['manifest']
    manifest = checked(path, entry['manifestSha256'])
    metadata = checked(path.parent / 'tasks.json', manifest['tasksSha256'])
    groups, ids, records = {}, {}, {}
    for split, spec in manifest['splits'].items():
        ids[split] = checked(path.parent / spec['idsFile'], spec['idsSha256'])
        members = [r for r in metadata if r['split'] == split]
        if len(ids[split]) != spec['count'] or len(set(ids[split])) != spec['count'] or [r['id'] for r in members] != ids[split]:
            raise ValueError(f'Invalid membership/order in {benchmark}/{split}')
        groups[split] = {r['group'] for r in members if 'group' in r}
        records[split] = {r['id']: r for r in members}
    if set(ids.get('search', [])) & set(ids.get('test', [])) or groups.get('search', set()) & groups.get('test', set()):
        raise ValueError('Search/test ID or family overlap')
    return manifest, ids, records


def verify(manifest, ids, records, data):
    for split, expected in manifest['splits'].items():
        raw = (data / f'{split}.jsonl').read_bytes()
        rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
        if [r['id'] for r in rows] != ids[split]:
            raise ValueError(f'Task IDs or order differ: {split}')
        for row in rows:
            if sha(canonical(row)) != records[split][row['id']]['recordSha256']:
                raise ValueError(f'Task content differs: {row["id"]}')
        if sha(canonical(rows)) != expected['recordsSha256']:
            raise ValueError(f'Record digest differs: {split}')
    return {'benchmark': manifest['benchmark'], 'protocol': manifest['protocol'],
            'verified': {s: len(v) for s, v in ids.items()}, 'knownPromptOverlaps': manifest['knownPromptOverlaps']}


def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def prepare(manifest, ids, records, source, out, download=False):
    """Use existing pinned converters; downloaded sources are opt-in and hash checked."""
    if out.exists():
        raise FileExistsError(f'Output exists; use verify or choose a new directory: {out}')
    if sha((REPO / manifest['upstreamLock']).read_bytes()) != manifest['upstreamLockSha256']:
        raise ValueError('The repository lock differs from this split release')
    name = manifest['benchmark']
    prepared, images = {}, {}
    if name in ('drop', 'humaneval', 'mbpp', 'gsm8k', 'math'):
        importer = module(REPO / 'scripts/benchmarks.py', 'aflow_importer')
        if source is None:
            if not download:
                raise ValueError('Provide --source aflow_data.tar.gz or --download')
            source = out.parent / '.sources/aflow_data.tar.gz'
            importer.fetch(source)
        if sha(source.read_bytes()) != importer.LOCK['archiveSha256']:
            raise ValueError('AFlow archive SHA-256 mismatch')
        with tarfile.open(source, 'r:gz') as archive:
            prepared = {s: [json.loads(line) for line in raw.splitlines()] for s, raw in importer.prepare(archive, name).items()}
    elif name == 'bfcl':
        if source is None:
            if not download:
                raise ValueError('Provide --source <pinned gorilla checkout> or --download')
            source = out.parent / '.sources/gorilla'
            if not source.exists():
                source.parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(['git', 'clone', '--filter=blob:none', '--no-checkout', 'https://github.com/ShishirPatil/gorilla.git', str(source)], check=True)
                subprocess.run(['git', '-C', str(source), 'checkout', '--detach', manifest['source']['revision']], check=True)
        revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        if revision != manifest['source']['revision']:
            raise ValueError('BFCL source revision mismatch')
        official = source / 'berkeley-function-call-leaderboard'
        lock = read(REPO / manifest['upstreamLock'])['bfcl']
        for relative, expected in lock['source']['sha256'].items():
            if sha((official / relative).read_bytes()) != expected:
                raise ValueError(f'BFCL source content differs: {relative}')
        source_rows = {}
        for category in ('multi_turn_base', 'multi_turn_miss_param', 'multi_turn_miss_func', 'multi_turn_long_context'):
            for line in (official / f'bfcl_eval/data/BFCL_v4_{category}.json').read_text().splitlines():
                row = json.loads(line)
                source_rows['bfcl:' + row['id']] = row
        for split, members in ids.items():
            prepared[split] = []
            for ident in members:
                row = source_rows[ident]
                prepared[split].append({'id': ident, 'benchmark': name, 'metric': name,
                    'prompt': '\n\n'.join(m['role'].upper() + ': ' + m['content'] for m in row['question'][0]),
                    'answer': '', 'dataset': {'protocol': manifest['protocol'], 'split': split},
                    'reference': {'bfclTaskId': row['id']}, 'group': records[split][ident]['group'],
                    'category': row['id'].rsplit('_', 1)[0]})
    elif name == 'automationbench':
        if source is None:
            raise ValueError('Provide --source tasks.jsonl exported from the pinned official AutomationBench environment; see README')
        pool = {}
        for line in source.read_text().splitlines():
            row = json.loads(line)
            ident = 'automationbench:' + row['info']['task_name']
            if ident in pool:
                raise ValueError(f'Duplicate source ID: {ident}')
            pool[ident] = row
        for split, members in ids.items():
            prepared[split] = []
            for ident in members:
                row = pool[ident]
                prepared[split].append({'id': ident, 'benchmark': name,
                    'prompt': '\n\n'.join(m['role'].upper() + ': ' + m['content'] for m in row['prompt']),
                    'answer': '', 'metric': name, 'dataset': {'protocol': manifest['protocol'], 'split': split},
                    'reference': {'automationTaskId': row['info']['task_name']}, 'group': row['info']['task_name']})
    elif name == 'humaneval_plus' and source is not None and source.is_file():
        lock = read(REPO / manifest['upstreamLock'])
        if sha(source.read_bytes()) != lock['sourceSha256']:
            raise ValueError('HumanEval+ source SHA-256 mismatch')
        with gzip.open(source, 'rt', encoding='utf-8') as f:
            pool = {r['task_id']: r for r in map(json.loads, f)}
        for split, members in ids.items():
            prepared[split] = []
            for ident in members:
                task = ident.removeprefix('humaneval_plus:')
                problem = pool[task]
                prepared[split].append({'id': ident, 'benchmark': name,
                    'dataset': {'protocol': manifest['protocol'], 'split': split},
                    'group': 'humaneval:' + task, 'prompt': problem['prompt'], 'answer': '',
                    'metric': 'evalplus', 'reference': {'prefix': problem['prompt'],
                    'entryPoint': problem['entry_point'], 'evalplusTaskId': task}})
    elif name == 'hle' and source is not None and source.is_file():
        if sha(source.read_bytes()) != manifest['source']['parquetSha256']:
            raise ValueError('HLE Parquet SHA-256 mismatch')
        try:
            import pyarrow.parquet as pq
        except ImportError as error:
            raise ValueError('HLE Parquet preparation requires pyarrow; metadata verification does not') from error
        locks = read(REPO / manifest['upstreamLock'])
        lock = next(v for v in locks.values() if v['protocol'] == manifest['protocol'])
        pool = {}
        for batch in pq.ParquetFile(source).iter_batches(batch_size=16, columns=['id', 'question', 'image', 'answer', 'category', 'answer_type']):
            for r in batch.to_pylist():
                pool['hle:' + r['id']] = r
        images = {}
        for split, members in ids.items():
            prepared[split] = []
            for ident in members:
                r = pool[ident]
                row = {'id': ident, 'benchmark': name, 'prompt': lock['systemPrompt'] + '\n\n' + r['question'],
                       'answer': r['answer'], 'metric': name}
                if manifest['protocol'] != 'hle-text-test-v1':
                    row.update(category=r['category'], answerType=r['answer_type'])
                    if r['image']:
                        header, encoded = r['image'].split(',', 1)
                        content = base64.b64decode(encoded, validate=True)
                        relative = 'collections/hle/images/' + sha(content) + '.bin'
                        images[relative] = content
                        row['images'] = [{'path': relative, 'sha256': sha(content), 'mimeType': header.removeprefix('data:').removesuffix(';base64')}]
                    row['group'] = records[split][ident]['group']
                    row['dataset'] = {'protocol': manifest['protocol'], 'split': split}
                else:
                    row['dataset'] = {'protocol': manifest['protocol'], 'split': split}
                    row['group'] = records[split][ident]['group']
                prepared[split].append(row)
        # Image paths are relative to the new output directory (BENCHMARK_HOME for this export).
        for relative, content in images.items():
            if sha(content) != Path(relative).stem:
                raise ValueError('HLE image hash mismatch')
    else:
        raise ValueError('Provide --source <pinned source file>; see README for HumanEval+ and authorized HLE downloads')
    # Validate all rows before creating an output directory. Never replace a published protocol.
    for split, rows in prepared.items():
        if [r['id'] for r in rows] != ids[split] or sha(canonical(rows)) != manifest['splits'][split]['recordsSha256']:
            raise ValueError(f'Prepared content does not match the published split: {split}')
    out.mkdir(parents=True)
    for split, rows in prepared.items():
        (out / f'{split}.jsonl').write_bytes(''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in rows).encode('utf-8'))
    for relative, content in images.items():
        path = out / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return verify(manifest, ids, records, out)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('list')
    for command in ('verify', 'prepare'):
        p = sub.add_parser(command)
        p.add_argument('--benchmark', required=True)
        p.add_argument('--protocol')
        if command == 'verify':
            p.add_argument('--data', type=Path)
        else:
            p.add_argument('--source', type=Path)
            p.add_argument('--out', type=Path, required=True)
            p.add_argument('--download', action='store_true')
    args = parser.parse_args()
    if args.command == 'list':
        for e in read(HERE / 'catalog.json')['entries']:
            m, ids, _ = load(e['benchmark'], e['protocol'])
            print(json.dumps({'benchmark': e['benchmark'], 'protocol': e['protocol'], 'counts': {s: len(v) for s, v in ids.items()}}))
        return
    m, ids, records = load(args.benchmark, args.protocol)
    result = ({'metadataVerified': True, 'protocol': m['protocol']} if args.data is None else verify(m, ids, records, args.data)) if args.command == 'verify' else prepare(m, ids, records, args.source, args.out, args.download)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, KeyError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
