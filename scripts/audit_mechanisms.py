#!/usr/bin/env python3
"""Read-only audit of native MFlow search lineages and observed execution mechanisms.

No model imports/calls. Source records stay private; exports contain aggregate metadata.
"""
import argparse
import collections
import csv
import hashlib
import json
import math
import re
import statistics
import sys
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_text())


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


def average(values):
    return statistics.mean(values) if values else None


def records(path):
    with Path(path).open() as f:
        for line in f:
            if line.strip():
                yield json.loads(line)


def code_key(code):
    # Conservative formatting normalization only: strings, variable names and logic remain.
    return digest(str(code).replace('\r\n', '\n').strip())


def graph_key(nodes):
    """Name-free typed DAG fingerprint; repeated identical shapes are not new programs."""
    lookup = {n['id']: n for n in nodes}
    cache = {}
    def visit(key, stack=()):
        if key in cache:
            return cache[key]
        if key in stack:
            return 'cycle'
        n = lookup.get(key)
        if n is None:
            return 'external'
        cache[key] = digest([n.get('type'), sorted(visit(d, stack + (key,)) for d in n.get('dependencies', []))])
        return cache[key]
    return digest(sorted(visit(k) for k in lookup))


def execution_org(ex):
    if not isinstance(ex, dict) or not ex.get('orchestration'):
        return None
    o = ex['orchestration']
    failures = collections.Counter()
    for g in o.get('graphs', []):
        for n in g.get('nodes', []):
            result = g.get('outputs', {}).get(n['id'], {})
            if result.get('status') in ('error', 'failed'):
                failures[n['type'] + ':' + str((result.get('error') or {}).get('code', 'UNKNOWN'))] += 1
    return {**o, 'agents': ex.get('agents', []), 'toolUsage': o.get('toolCalls'),
            'toolCalls': len(ex.get('toolEvents', [])), 'nodeFailures': dict(failures),
            'edges': ex.get('edges', []), 'depth': ex.get('depth'), 'stopReason': ex.get('stopReason')}


class Observations:
    def __init__(self):
        self.n = 0
        self.c = collections.Counter()
        self.templates = collections.Counter()
        self.failures = collections.Counter()
        self.graphs = set()
        self.programs = set()
        self.topologies = collections.Counter()
        self.tools = collections.Counter()
        self.depths = collections.Counter()

    def add(self, org):
        self.n += 1
        if org is None:
            return
        self.c['organizationObserved'] += 1
        lifecycle = org.get('lifecycle')
        if lifecycle is not None:
            self.c['lifecycleObserved'] += 1
            spawn = [e for e in lifecycle if e.get('action') == 'SPAWN']
            initial = [e for e in lifecycle if e.get('action') == 'INITIAL']
            self.c['spawnEvents'] += len(spawn)
            self.c['spawnedEpisodes'] += bool(spawn)
            self.c['rootOnlyEpisodes'] += not spawn and len(initial) == 1
            self.c['multipleInitialEpisodes'] += len(initial) > 1
            parents = {e['agentId']: e.get('parentId') for e in spawn}
            self.c['recursiveSpawnEpisodes'] += any(p in parents for p in parents.values())
            for e in spawn:
                self.templates[e.get('templateId') or '<generated-profile>'] += 1
            self.c['outsideTemplateSpawnEvents'] += sum(not e.get('templateId') for e in spawn)
            members = {e['agentId']: e.get('profile', {}) for e in initial + spawn}
            def owner(node):
                return next((m for m in members if node == m or node.startswith(m + '/')), None)
            local_shapes = collections.defaultdict(set)
            cross = 0
            for g in org.get('graphs', []):
                nodes = g.get('nodes', [])
                self.graphs.add(graph_key(nodes))
                for m in members:
                    own = [n for n in nodes if owner(n['id']) == m]
                    if own:
                        local_shapes[m].add(graph_key(own))
                for n in nodes:
                    cross += sum(owner(n['id']) is not None and owner(d) is not None and owner(n['id']) != owner(d) for d in n.get('dependencies', []))
            # Observed node shapes, not a claim about semantic equivalence or scheduled concurrency.
            self.c['crossAgentDependencyEdges'] += cross
            self.c['crossAgentDependencyEpisodes'] += cross > 0
            shapes = {tuple(sorted(x)) for x in local_shapes.values()}
            self.c['multipleExecutedShapeEpisodes'] += len(shapes) > 1
            self.c['executedMemberTotal'] += len(local_shapes)
            tree = collections.defaultdict(list)
            for child, parent in parents.items(): tree[parent].append(child)
            def tree_shape(node, seen=()):
                if node in seen: return 'cycle'
                return '(' + ''.join(sorted(tree_shape(c, seen + (node,)) for c in tree[node])) + ')'
            roots = [e['agentId'] for e in initial]
            self.topologies[digest(sorted(tree_shape(root) for root in roots))] += 1
        if org.get('depth') is not None:
            self.depths[str(org['depth'])] += 1
        self.failures.update(org.get('nodeFailures', {}))
        self.c['nodeFailureEpisodes'] += bool(org.get('nodeFailures'))
        self.c['explicitEvidenceEdges'] += len(org.get('edges', []))
        self.c['toolObservations'] += org.get('toolCalls', 0) if isinstance(org.get('toolCalls'), int) else 0
        programs = org.get('programs')
        if programs is not None:
            self.c['programRegistryObserved'] += 1
            generated = [p for p in programs if p.get('origin') == 'generated']
            self.c['generatedProgramBindings'] += len(generated)
            self.c['generatedProgramEpisodes'] += bool(generated)
            self.programs.update(code_key(p.get('composition', '')) for p in generated)
        definitions, usage = org.get('tools'), org.get('toolUsage')
        if definitions is not None:
            self.c['toolRegistryObserved'] += 1
            generated = [t for t in definitions if t.get('origin') == 'generated']
            self.c['registeredGeneratedTools'] += len(generated)
            self.c['generatedToolEpisodes'] += bool(generated)
            self.c['inheritedLibraryRegistrations'] += sum(t.get('origin') == 'library' for t in definitions)
        if usage is not None:
            self.c['toolUsageObserved'] += 1
            self.c['createToolAttempts'] += sum(x.get('name') == 'create_tool' for x in usage)
            self.c['createToolSuccessObservations'] += sum(x.get('name') == 'create_tool' and x.get('status') == 'success' for x in usage)
            for x in usage:
                self.tools[x.get('name', '?') + ':' + x.get('status', '?')] += 1
            generated = {t['definition']['name']: t for t in definitions or [] if t.get('origin') == 'generated'}
            good = [x for x in usage if x.get('name') in generated and x.get('status') == 'success']
            self.c['successfulGeneratedToolCalls'] += len(good)
            self.c['successfulGeneratedToolEpisodes'] += bool(good)
            shared = [x for x in good if x.get('agentId') != generated[x['name']].get('creatorId')]
            self.c['crossAgentGeneratedToolCalls'] += len(shared)
            self.c['crossAgentGeneratedToolEpisodes'] += bool(shared)

    def finish(self):
        result = {'episodes': self.n, **dict(self.c), 'spawnTemplates': dict(self.templates),
                  'nodeFailures': dict(self.failures), 'toolOutcomes': dict(self.tools),
                  'depthDistribution': dict(self.depths), 'distinctTypedGraphShapes': len(self.graphs),
                  'distinctGeneratedSourceHashes': len(self.programs), 'distinctSpawnTreeShapes': len(self.topologies)}
        for k in ['organizationObserved','lifecycleObserved','programRegistryObserved','toolRegistryObserved','toolUsageObserved']:
            result.setdefault(k, 0)
        return result


def account(paths, optimizer=False):
    c = collections.Counter()
    for path in paths:
        batches = records(path) if optimizer else [read(path)]
        for batch in batches:
            rows = batch.get('records', []) if isinstance(batch, dict) else batch
            for row in rows:
                u = row.get('usage')
                if row.get('status') == 'known' and isinstance(u, dict):
                    c['knownTokens'] += u.get('totalTokens', u.get('inputTokens', 0) + u.get('outputTokens', 0))
                    c['inputTokens'] += u.get('inputTokens', 0)
                    c['outputTokens'] += u.get('outputTokens', 0)
                    c['cachedInputTokens'] += u.get('cachedInputTokens', 0)
                    c['knownCalls'] += 1
                else:
                    c['unknownCalls'] += 1
                c['chargedTokens'] += row.get('charged', 0)
    return dict(c)


def strategy_delta(parent, child):
    result = {'changedComponents': [], 'addedTemplates': [], 'removedTemplates': [], 'changedTemplatePrograms': [], 'changedProfiles': [], 'normalizedLibraryChanged': False}
    if parent is None or child is None:
        result['unavailable'] = True
        return result
    if code_key(parent.get('composition','')) != code_key(child.get('composition','')):
        result['changedComponents'].append('outer_policy')
    if parent.get('prompts') != child.get('prompts'):
        result['changedComponents'].append('global_prompts')
    a, b = parent.get('organization',{}), child.get('organization',{})
    for field, label in [('initialAgents','initial_profiles'),('initialBindings','initial_bindings'),('toolLibrary','tool_library'),('toolCreation','tool_creation_capability')]:
        if a.get(field) != b.get(field): result['changedComponents'].append(label)
    aa = {t['id']:t for t in a.get('agentTemplates',[])}
    bb = {t['id']:t for t in b.get('agentTemplates',[])}
    result['addedTemplates'] = sorted(bb.keys()-aa.keys())
    result['removedTemplates'] = sorted(aa.keys()-bb.keys())
    for name in aa.keys() & bb.keys():
        if code_key(aa[name].get('composition','')) != code_key(bb[name].get('composition','')): result['changedTemplatePrograms'].append(name)
        if aa[name].get('profile') != bb[name].get('profile'): result['changedProfiles'].append(name)
    # Exclude template IDs/descriptions and profile IDs from library identity, retaining real contracts.
    def library(t):
        return sorted(digest([code_key(x.get('composition','')), {k:v for k,v in x.get('profile',{}).items() if k!='id'}]) for x in t.values())
    result['normalizedLibraryChanged'] = library(aa) != library(bb)
    result['identicalExceptRoundId'] = strategy_content(parent) == strategy_content(child)
    return result


def strategy_content(strategy):
    return {k: v for k, v in strategy.items() if k != 'id'}


def load_strategy(root, number):
    root = Path(root)
    for f in [root/f'round-candidates/round-{number}.json', root/f'round-candidates/round-{number}/best.json']:
        if f.exists():
            return read(f).get('strategy'), 'frozen_candidate'
    native = next(root.glob('*/workflows'), None)
    f = native/f'round_{number}/strategy.json' if native else None
    return (read(f), 'native_strategy') if f and f.exists() else (None, None)


def annotate_artifacts(search, root):
    strategies, seen = {}, {}
    for row in search.get('rounds', []):
        n = row['round']
        strategy, source = load_strategy(root, n)
        strategies[n] = strategy
        row['artifactSource'] = source
        row['auditContentHash'] = digest(strategy_content(strategy)) if strategy is not None else None
        row.pop('strategyHash', None)
        row['sameAsEarlierRoundIgnoringId'] = seen.get(row['auditContentHash'])
        if strategy is not None:
            seen.setdefault(row['auditContentHash'], n)
        if row['parent'] is not None:
            row['changes'] = strategy_delta(strategies.get(row['parent']), strategy)
        elif n != 1:
            row['changes'] = {'changedComponents': [], 'unavailable': True}
        row['sameAsParentIgnoringId'] = row['changes'].get('identicalExceptRoundId')


def complete_task_sets(task_sets, expected, repeats):
    return (len(task_sets) == repeats and
            all(len(ids) == expected and len(set(ids)) == expected for ids in task_sets) and
            all(set(ids) == set(task_sets[0]) for ids in task_sets))


def audit_search(root, expected, repeats):
    root = Path(root)
    if not root.exists(): return {'available': False, 'rounds': [], 'reason': 'Search directory absent'}
    native = next(root.glob('*/workflows'), None)
    table = read(native/'results.json') if native and (native/'results.json').exists() else []
    published = collections.defaultdict(list)
    for row in table: published[int(row['round'])].append(row['score'])
    dirs = {int(p.name.split('-')[1]):p for p in root.glob('round-*') if p.is_dir() and re.fullmatch(r'round-\d+',p.name)}
    if native:
        for p in native.glob('round_*'):
            if re.fullmatch(r'round_\d+',p.name):dirs.setdefault(int(p.name.split('_')[1]),root/('round-'+p.name.split('_')[1]))
    rounds, means, strategies = [], {}, {}
    total_account = collections.Counter()
    optimizer = collections.defaultdict(collections.Counter)
    if (root/'optimizer-usage.jsonl').exists():
        for batch in records(root/'optimizer-usage.jsonl'):
            for row in batch.get('records',[]):
                u=row.get('usage')
                optimizer[int(batch['round'])]['knownTokens'] += (u or {}).get('totalTokens',0) if row.get('status')=='known' else 0
                optimizer[int(batch['round'])]['unknownCalls'] += row.get('status')!='known'
    for number, directory in sorted(dirs.items()):
        expfile = native/f'round_{number}/experience.json' if native else None
        exp = read(expfile) if expfile and expfile.exists() else {}
        strategyfile = native/f'round_{number}/strategy.json' if native else None
        strategy = read(strategyfile) if strategyfile and strategyfile.exists() else None
        if strategy is None:
            for f in [root/f'round-candidates/round-{number}.json',root/f'round-candidates/round-{number}/best.json']:
                if f.exists():strategy=read(f).get('strategy');break
        strategies[number]=strategy
        observations = Observations()
        per_task=collections.defaultdict(list)
        pass_counts, pass_scores, error_counts = {}, {}, collections.Counter()
        task_sets = []
        contract_errors=0
        for directory_pass in sorted(directory.glob('pass-*')):
            rows=[]; pass_ids=[]
            for p in sorted(directory_pass.glob('*.json')):
                if not p.stem.isdigit():continue
                try: row=read(p)
                except (json.JSONDecodeError,OSError):error_counts['unreadable_committed_row']+=1;continue
                if 'taskId' not in row:continue
                score=row.get('f1',row.get('score'))
                if isinstance(score,(int,float)) and math.isfinite(score):
                    per_task[row['taskId']].append(score);rows.append(score)
                    pass_ids.append(row['taskId'])
                org=row.get('organization')
                observations.add(org)
                if row.get('error'):
                    contract_errors+=1
                    msg=str(row['error'])
                    kind=('contract' if re.search(r'contract|AgentOutput|must return|undefined|Unknown agent|native',msg,re.I) else 'execution_error')
                    error_counts[kind]+=1
            pass_counts[directory_pass.name]=len(rows)
            pass_scores[directory_pass.name]=average(rows)
            task_sets.append(pass_ids)
        usage=account(sorted(directory.glob('pass-*/*.usage.json')))
        opt=dict(optimizer[number])
        known=usage.get('knownTokens',0)+opt.get('knownTokens',0)
        total_account.update(usage)
        total_account['optimizerKnownTokens']+=opt.get('knownTokens',0)
        total_account['optimizerUnknownCalls']+=opt.get('unknownCalls',0)
        complete=complete_task_sets(task_sets, expected, repeats)
        score=average(list(pass_scores.values())) if complete else None
        status='complete' if complete else 'partial'
        if contract_errors:status='complete_with_execution_errors' if complete else 'partial_with_execution_errors'
        if sum(pass_counts.values())==0:status='not_evaluated'
        mean_tasks={k:average(v) for k,v in per_task.items()}
        means[number]=mean_tasks
        parent=exp.get('father node')
        try:parent=int(parent) if parent is not None else None
        except (ValueError,TypeError):parent=None
        parent_record=next((r for r in rounds if r['round']==parent),None)
        comparable=complete and parent_record is not None and parent_record['complete'] and set(mean_tasks)==set(means[parent])
        paired={}
        if comparable:
            delta=[mean_tasks[k]-means[parent][k] for k in mean_tasks]
            paired={'tasks':len(delta),'improved':sum(x>1e-10 for x in delta),'regressed':sum(x< -1e-10 for x in delta),'unchanged':sum(abs(x)<=1e-10 for x in delta),'meanDelta':average(delta)}
        changes=strategy_delta(strategies.get(parent),strategy) if parent else {'changedComponents':['seed']}
        row={'round':number,'parent':parent,'complete':complete,'status':status,'passCounts':pass_counts,'passScores':pass_scores,
             'score':score,'partialObservedScore':average([x for scores in per_task.values() for x in scores]),
             'recordedControllerScores':published[number], 'executionErrorRows':contract_errors,'errors':dict(error_counts),
             'pairedWithParent':paired,'changes':changes,'mechanisms':observations.finish(),'usage':usage,'optimizerUsage':opt,
             'roundKnownTokens':known,'cumulativeKnownTokens':total_account['knownTokens']+total_account['optimizerKnownTokens'],
             'cumulativeUnknownCalls':total_account['unknownCalls']+total_account['optimizerUnknownCalls'],
             'strategyHash':digest(strategy) if strategy else None,'evidenceFile':str(expfile.relative_to(root)) if expfile and expfile.exists() else None,
             'declaredModification':exp.get('modification','')}
        rounds.append(row)
        print(f'  R{number}: {status}, {sum(pass_counts.values())} rows',file=sys.stderr)
    summary=read(root/'summary.json') if (root/'summary.json').exists() else {}
    result = {'available':True,'rounds':rounds,'summary':summary,'usage':dict(total_account),
            'expectedTasksPerPass':expected,'expectedPassesPerRound':repeats,
            'controllerPhase':read(root/'controller.json').get('phase') if (root/'controller.json').exists() else None}
    annotate_artifacts(result, root)
    return result


def audit_test(root):
    root=Path(root)
    if not root.exists():return {'available':False}
    summary=read(root/'summary.json') if (root/'summary.json').exists() else {}
    observations=Observations(); scores=[]; ids=[]
    path=root/'test.jsonl'
    if path.exists():source=records(path)
    else:source=(read(p) for p in sorted((root/'rows').glob('*.json')))
    for row in source:
        if row.get('taskId') is None:continue
        ids.append(row['taskId']);scores.append(row.get('f1',row.get('score',0)))
        observations.add(row.get('organization') or execution_org(row.get('execution')))
    usage=summary.get('accounting')
    if usage is None:
        files=list((root/'task-usage').glob('*.json'))
        if files:usage=account(files)
        elif summary.get('usage') is not None:usage=account([root/'usage.json']) if (root/'usage.json').exists() else None
    return {'available':True,'count':len(ids),'uniqueTasks':len(set(ids)),'taskIdsHash':digest(sorted(ids)),
            'accuracy':summary.get('accuracy'),'meanF1':summary.get('meanF1'), 'observedMean':average(scores),
            'usage':usage,'mechanisms':observations.finish(),'summaryCount':summary.get('count')}


def run(spec):
    print('Auditing '+spec['id'],file=sys.stderr)
    result={k:v for k,v in spec.items() if k not in ['search','tests']}
    result['search']=audit_search(spec['search'],spec['count'],spec.get('repeats',5)) if spec.get('search') else {'available':False,'rounds':[]}
    result['tests']={name:audit_test(path) for name,path in spec.get('tests',{}).items()}
    return result


def main():
    p=argparse.ArgumentParser(description=__doc__)
    source=p.add_mutually_exclusive_group(required=True)
    source.add_argument('--spec',type=Path)
    source.add_argument('--spec-json')
    p.add_argument('--out',type=Path)
    args=p.parse_args()
    spec=read(args.spec) if args.spec else json.loads(args.spec_json)
    output=[run(s) for s in spec]
    text=json.dumps(output,indent=2)+'\n'
    if args.out:
        args.out.parent.mkdir(parents=True,exist_ok=True);args.out.write_text(text)
    else:print(text)

if __name__=='__main__':main()
