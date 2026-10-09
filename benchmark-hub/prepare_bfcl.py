"""Deterministic family-disjoint BFCL view. Uses public prompts, never model results."""
import argparse
import hashlib
import json
import subprocess
from collections import defaultdict
from pathlib import Path
from bench import read, save, sha, verify
from prepare_extra import jsonl

PROTOCOL = 'bfcl-multiturn-family-v1'
CATEGORIES = ['multi_turn_base', 'multi_turn_miss_param', 'multi_turn_miss_func', 'multi_turn_long_context']
REVISION = '6ea57973c7a6097fd7c5915698c54c17c5b1b6c8'


def prepare(root):
    verify(root, 'bfcl')
    catalog = read(root / 'catalog.json'); record = catalog['benchmarks']['bfcl']
    official = root / record['raw'] / 'official/berkeley-function-call-leaderboard'
    # Catalog raw can point to the official checkout itself on older installations.
    if not official.exists():
        official = root / 'collections/official-20260930/BFCL/official/berkeley-function-call-leaderboard'
    if subprocess.check_output(['git', '-C', str(official), 'rev-parse', 'HEAD'], text=True).strip() != REVISION:
        raise ValueError('BFCL checkout revision mismatch')
    data = official / 'bfcl_eval/data'
    rows = [r for cat in CATEGORIES for r in map(json.loads, (data / f'BFCL_v4_{cat}.json').read_text().splitlines())]
    assert len(rows) == 800
    parent = {i: i for i in range(200)}
    def find(i):
        while parent[i] != i: i = parent[i]
        return i
    seen = {}
    for r in rows:
        i = int(r['id'].rsplit('_', 1)[1])
        key = ' '.join(json.dumps(r['question'][0], sort_keys=True).lower().split())
        if key in seen: parent[find(i)] = find(seen[key])
        seen[key] = i
    groups = defaultdict(list)
    for i in parent: groups[find(i)].append(i)
    selected = set()
    for group in sorted(groups.values(), key=lambda g: hashlib.sha256(('42:' + ','.join(map(str, g))).encode()).hexdigest()):
        if len(selected) + len(group) <= 50: selected.update(group)
    assert len(selected) == 50
    view = root / 'views' / PROTOCOL
    lock = {'protocol': PROTOCOL, 'source': {'revision': REVISION, 'path': str(official.relative_to(root)),
        'sha256': {str(p.relative_to(official)): sha(p) for p in sorted((official / 'bfcl_eval').rglob('*')) if p.suffix in ('.json', '.py') and p.is_file()}},
        'scope': 'Custom 200 search / 600 test across four BFCL V4 multi-turn categories; not the full BFCL leaderboard',
        'splitMethod': {'seed': 42, 'grouping': 'numeric family, union identical normalized first public question', 'searchFamilies': sorted(selected)},
        'toolset': 'shared-conversation-v1', 'splits': {}}
    for split in ('search', 'test'):
        tasks = []
        for r in rows:
            i = int(r['id'].rsplit('_', 1)[1])
            if (i in selected) != (split == 'search'): continue
            tasks.append({'id': 'bfcl:' + r['id'], 'benchmark': 'bfcl', 'metric': 'bfcl',
                'prompt': '\n\n'.join(m['role'].upper() + ': ' + m['content'] for m in r['question'][0]),
                'answer': '', 'dataset': {'protocol': PROTOCOL, 'split': split},
                'reference': {'bfclTaskId': r['id']}, 'group': 'bfcl-family:' + str(find(i)), 'category': r['id'].rsplit('_', 1)[0]})
        lock['splits'][split] = jsonl(view / (split + '.jsonl'), tasks)
    save(view / 'manifest.json', lock)
    record.update(defaultProtocol=PROTOCOL, runtime='ready')
    record.setdefault('views', {})[PROTOCOL] = {'path': str(view.relative_to(root)), 'format': 'mflow-jsonl', 'runtime': 'ready', 'searchCount': 200, 'testCount': 600}
    files = read(root / catalog['fileManifest'])
    for file in view.iterdir(): files[str(file.relative_to(root))] = {'sha256': sha(file), 'bytes': file.stat().st_size}
    save(root / catalog['fileManifest'], files); save(root / 'catalog.json', catalog)
    locks_path = Path(__file__).resolve().parents[1] / 'data/extended-benchmarks.lock.json'
    locks = read(locks_path); locks['bfcl'] = lock; save(locks_path, locks)
    return lock['splits']

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('--root', type=Path, default=Path('../Benchmarks'))
    print(json.dumps(prepare(parser.parse_args().root.resolve())))
