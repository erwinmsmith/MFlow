#!/usr/bin/env python3
"""Publish metadata from already verified views. Never publish questions or answers."""
import argparse
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def publish(root, out):
    aflow = json.loads((REPO / 'data/aflow.lock.json').read_text())
    extra = json.loads((REPO / 'data/extended-benchmarks.lock.json').read_text())
    plus = json.loads((REPO / 'data/humaneval-plus.lock.json').read_text())
    catalog = json.loads((root / 'catalog.json').read_text())['benchmarks']
    entries = []
    for name, record in catalog.items():
        for protocol, view in record.get('views', {}).items():
            if name in ('drop', 'math', 'mbpp', 'gsm8k', 'humaneval'):
                lockpath = 'data/aflow.lock.json'
                lock = {'protocol': aflow['protocol'], 'source': {k: aflow[k] for k in ('upstreamCommit', 'url', 'archiveSha256')},
                        'splits': {s: {'count': aflow['files'][f'{name}_{orig}.jsonl']['count'], 'sha256': aflow['files'][f'{name}_{orig}.jsonl']['convertedSha256']} for s, orig in [('search', 'validate'), ('test', 'test')]}}
            elif name == 'humaneval_plus':
                lockpath, lock = 'data/humaneval-plus.lock.json', plus
            else:
                matches = [v for v in extra.values() if v['protocol'] == protocol]
                if len(matches) != 1:
                    raise ValueError(f'No unique committed lock for {name}/{protocol}')
                lockpath, lock = 'data/extended-benchmarks.lock.json', matches[0]
            destination = out / name / lock['protocol']
            manifest = {'schemaVersion': 1, 'benchmark': name, 'protocol': lock['protocol'],
                        'upstreamLock': lockpath, 'upstreamLockSha256': sha((REPO / lockpath).read_bytes()),
                        'source': {k: v for k, v in {**record.get('source', {}), **lock.get('source', {})}.items() if k not in ('path', 'sha256')},
                        'splitMethod': lock.get('splitMethod', {'method': 'Preserve the published upstream membership and order.' if name not in ('automationbench', 'humaneval_plus') else ('simple tasks for search; six public domains for test' if name == 'automationbench' else 'Inherit AFlow HumanEval task membership and order; use EvalPlus questions and grading.')}),
                        'scope': ('AFlow HumanEval membership with EvalPlus v0.1.10 inputs and tests.' if name == 'humaneval_plus' else lock.get('scope', record.get('scope', 'Pinned AFlow release subset; not the entire original dataset.'))),
                        'splits': {}, 'knownPromptOverlaps': aflow['knownPromptOverlaps'] if name == 'drop' else []}
            metadata = []
            for split, expected in lock['splits'].items():
                raw = (root / view['path'] / f'{split}.jsonl').read_bytes()
                if sha(raw) != expected['sha256']:
                    raise ValueError(f'Committed data lock mismatch: {name}/{protocol}/{split}')
                rows = [json.loads(line) for line in raw.splitlines() if line.strip()]
                ids = [r['id'] for r in rows]
                if len(rows) != expected['count'] or len(set(ids)) != len(ids):
                    raise ValueError(f'Invalid count or duplicate IDs: {name}/{split}')
                write(destination / f'{split}.ids.json', ids)
                manifest['splits'][split] = {**expected, 'idsFile': f'{split}.ids.json',
                    'idsSha256': sha((destination / f'{split}.ids.json').read_bytes()), 'recordsSha256': sha(canonical(rows))}
                for r in rows:
                    metadata.append({'id': r['id'], 'split': split, 'recordSha256': sha(canonical(r)),
                        'promptSha256': sha(r['prompt'].encode()),
                        **{k: r[k] for k in ('group', 'category') if k in r}})
            write(destination / 'tasks.json', metadata)
            manifest['tasksSha256'] = sha((destination / 'tasks.json').read_bytes())
            write(destination / 'manifest.json', manifest)
            entries.append({'benchmark': name, 'protocol': lock['protocol'], 'manifest': str((destination / 'manifest.json').relative_to(out)),
                            'manifestSha256': sha((destination / 'manifest.json').read_bytes())})
    write(out / 'catalog.json', {'schemaVersion': 1, 'release': 'mflow-splits-v1', 'entries': entries,
        'assetsOnly': ['gaia', 'tau3'], 'notice': 'Metadata only. Obtain datasets from their upstream publishers under their access terms. No model calls are needed.'})
    return len(entries)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--out', type=Path, default=HERE)
    args = parser.parse_args()
    print(json.dumps({'publishedProtocols': publish(args.root, args.out)}))
