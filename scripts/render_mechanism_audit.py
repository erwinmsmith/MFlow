#!/usr/bin/env python3
"""Render aggregate-only mechanism reports. Curves adapt data-viz Figure 04.

The time-course axes, palette, and line/errorbar encoding are retained. Biological
insets, phases and annotations are removed. Error bars are SD across full passes.
"""
import argparse
import collections
import csv
import json
import math
import statistics
from pathlib import Path


def pct(v):return '—' if v is None else f'{100*v:.2f}%'
def num(v):return '—' if v is None else str(v)
def tokens(v):return '—' if v is None else f'{v/1e6:,.2f}M'


def fault_affected(r):
    return bool(r.get('executionErrorRows') or r.get('reviewedEngineeringFault'))


def categories(r):
    c=r['changes']; result=[]
    text=r.get('declaredModification','').lower()
    if 'seed' in c.get('changedComponents',[]):return ['seed']
    if c.get('unavailable'):return ['unavailable']
    if r.get('sameAsParentIgnoringId'):return ['identical_payload_repeat']
    if 'outer_policy' in c['changedComponents']:
        result.append('MAS_control')
        if any(x in text for x in ['spawn','deriv','stop','termination','gate','early exit','dormant']):result.append('spawn_or_stop_declared')
        if any(x in text for x in ['rout','evidence','context','communicat','integrat','message','share']):result.append('evidence_routing_declared')
    if c.get('changedTemplatePrograms') or c.get('addedTemplates') or c.get('removedTemplates'):result.append('agent_library_or_program')
    if c.get('changedProfiles') or 'initial_profiles' in c['changedComponents']:result.append('profiles_or_permissions')
    if 'global_prompts' in c['changedComponents']:result.append('global_prompts')
    if any(x in c['changedComponents'] for x in ['tool_library','tool_creation_capability']):result.append('tool_definition_or_capability')
    if any(x in text for x in ['contract','serialization','undefined','invalid_input','interface','string(r.result)','duplicate id']):result.append('interface_repair_declared')
    return result or ['other_artifact_change']


def measured(m,key,coverage):
    return m.get(key,0) if m.get(coverage,0) else None


def write_csv(path,rows):
    if not rows:return
    fields=list(dict.fromkeys(k for r in rows for k in r))
    with path.open('w',newline='') as f:
        w=csv.DictWriter(f,fieldnames=fields,lineterminator='\n');w.writeheader();w.writerows(rows)


def curve(run,out):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib.lines import Line2D
    rounds=run['search']['rounds']
    complete=[r for r in rounds if r['complete'] and r['score'] is not None]
    if not complete:return False
    # Figure 04's canvas and main axes geometry; reclaimed inset space stays within the same axes.
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':20,'axes.linewidth':2,'svg.fonttype':'none','pdf.fonttype':42})
    fig=plt.figure(figsize=(10.4,10.76),dpi=120)
    ax=fig.add_axes([199/1040,1-(175+770)/1076,770/1040,770/1076])
    for name,spine in ax.spines.items():spine.set_visible(name in ['left','bottom'])
    x=[r['cumulativeKnownTokens']/1e6 for r in complete]
    y=[r['score']*100 for r in complete]
    sd=[statistics.stdev(list(r['passScores'].values()))*100 if len(r['passScores'])>1 else 0 for r in complete]
    best=[]
    for v in y:best.append(max(best[-1] if best else v,v))
    ax.errorbar(x,y,yerr=sd,color='#7297d5',lw=2.5,marker='o',ms=6,mec='black',mew=.7,ecolor='#7297d5',elinewidth=1,capsize=3,label='Candidate mean ± SD')
    ax.step(x,best,where='post',color='#459b9e',lw=3,label='Best completed mean')
    bad=[r for r in complete if fault_affected(r)]
    if bad:ax.scatter([r['cumulativeKnownTokens']/1e6 for r in bad],[r['score']*100 for r in bad],color='#b74332',marker='x',s=80,zorder=4,label='Execution or reviewed interface fault')
    repeats=[r for r in complete if r.get('sameAsParentIgnoringId')]
    if repeats:ax.scatter([r['cumulativeKnownTokens']/1e6 for r in repeats],[r['score']*100 for r in repeats],facecolors='none',edgecolors='#8661a9',marker='s',s=95,zorder=5,label='Same payload as parent (except ID)')
    ax.set_xlabel('Cumulative known search tokens (M)',labelpad=14)
    ax.set_ylabel('Search mean F1 (%)' if run['benchmark']=='drop' else 'Search accuracy (%)',labelpad=14)
    ax.grid(axis='y',alpha=.18)
    lo=min(a-b for a,b in zip(y,sd));hi=max(a+b for a,b in zip(y,sd))
    pad=max(2,(hi-lo)*.12);ax.set_ylim(max(0,lo-pad),min(101,hi+pad))
    last_cost=rounds[-1]['cumulativeKnownTokens']/1e6
    if last_cost > max(x):
        ax.plot([max(x),last_cost],[best[-1],best[-1]],color='#459b9e',ls=':',lw=2)
    ax.set_xlim(left=0,right=max(last_cost,max(x))*1.07 if max(x)>0 else 1)
    selected=run['search'].get('summary',{}).get('selectedRound')
    if selected:
        r=next((r for r in complete if r['round']==selected),None)
        if r:ax.annotate(f'Selected R{selected}',(r['cumulativeKnownTokens']/1e6,r['score']*100),xytext=(0,-25),textcoords='offset points',fontsize=13,ha='center')
    fig.suptitle(run['id'].replace('_',' '),fontsize=22,y=.99)
    handles,labels=ax.get_legend_handles_labels();fig.legend(handles,labels,loc='upper center',bbox_to_anchor=(.56,.95),fontsize=13,frameon=False,ncol=1)
    fig.text(.19,.01,'Complete passes only; cost includes partial/error rounds and optimizer calls.\nKnown tokens exclude unknown usage; SD is not a confidence interval.',fontsize=11)
    for ext in ['png','svg','pdf']:fig.savefig(out/f"{run['id']}-curve.{ext}")
    svg=out/f"{run['id']}-curve.svg"
    svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
    plt.close(fig);return True


def tree(run,out):
    rows=run['search']['rounds'];lines=['flowchart TD']
    for r in rows:
        value=pct(r['score']) if r['complete'] else f"partial {sum(r['passCounts'].values())}/{run['count']*run.get('repeats',5)}"
        label=f"R{r['round']} | {value}"
        if r['executionErrorRows']:label+=' | execution faults'
        if r.get('reviewedEngineeringFault'):label+=' | reviewed interface fault'
        if r.get('sameAsParentIgnoringId'):label+=' | same parent payload'
        lines.append(f'  r{r["round"]}["{label}"]')
    ids={r['round'] for r in rows}
    for r in rows:
        if r['parent'] in ids:lines.append(f'  r{r["parent"]} --> r{r["round"]}')
    for r in rows:
        if not r['complete']:lines.append(f'  style r{r["round"]} fill:#eeeeee,stroke:#888888')
        elif fault_affected(r):lines.append(f'  style r{r["round"]} fill:#f8d8d2,stroke:#b74332')
        elif r.get('sameAsParentIgnoringId'):lines.append(f'  style r{r["round"]} fill:#eee3f7,stroke:#8661a9')
    content='\n'.join(lines)+'\n';(out/f"{run['id']}-tree.mmd").write_text(content)
    return content


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--input',type=Path,nargs='+',required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--identities',type=Path);p.add_argument('--reviewed-faults',type=Path);a=p.parse_args()
    runs=[r for f in a.input for r in json.loads(f.read_text())]
    reviewed=json.loads(a.reviewed_faults.read_text()) if a.reviewed_faults else []
    faults={(r['lineage'],r['round']):r['reason'] for r in reviewed}
    for run in runs:
        for r in run['search'].get('rounds',[]):r['reviewedEngineeringFault']=faults.get((run['id'],r['round']))
    a.out.mkdir(parents=True,exist_ok=True);figs=a.out/'figures';figs.mkdir(exist_ok=True)
    round_rows=[];test_rows=[];search_rows=[];category_rows=[];identity_rows=[]
    identities=json.loads(a.identities.read_text()) if a.identities else []
    doc=['# MFlow search and mechanism audit','',
         'Read-only snapshot, 2026-10-12 (Asia/Shanghai). No model requests or experiment restarts. This report covers the indexed MFlow lineages and available test variants; it does not pool incompatible versions or claim a causal ablation from observational traces.','',
         'Start with the [findings and interpretation](FINDINGS.md). The tables below preserve lineage-level evidence and limitations.','',
         '## Coverage and interpretation','',
         '- Evaluated benchmarks: MATH, DROP, MBPP, AutomationBench, BFCL, and the partial paused HLE run. Remote Qwen/MATH is separate from DeepSeek. HumanEval, HumanEval+, GSM8K, GAIA, and tau3 have no MFlow search lineage in the inspected experiment index. Prepared data is not experimental evidence.',
         '- The primary search unit is a task × pass; test units are unique tasks. Partial rounds never receive a complete-round mean. Parent comparisons use the actual recorded father node and require complete matched task sets.',
         '- Complete means reproduce the stored task outcomes, including stored execution-error zeros. Such rounds are marked fault-affected and excluded from the clean category association table. Node/tool failures are shown separately and may be recovered within an otherwise successful task.',
         '- Manually reviewed interface faults are separate from recorded execution errors; see `reviewed-faults.json`. These rounds are also excluded from clean category comparisons. In particular, a successful tool call can still implement the wrong interface behavior.',
         '- Changes are observed artifact differences. Labels ending in `declared` are keyword classifications of optimizer descriptions, not verified isolated interventions. Multiple components can change at once. Per-category score associations are not causal effects.',
         '- Payload identity excludes only the top-level round ID and prefers frozen candidates over native source exports. Identical payloads are repeated evaluations, not verified structural mutations. Environment/provider changes can still affect execution. Runtime manifest digests and the audit content hashes use different serialization and are explicitly separate.',
         '- Typed DAG shapes discard node names and preserve node types and dependency structure. This is a structural fingerprint, not a semantic-equivalence proof. Generated source hashes remain conservative text identities; more hashes do not prove more useful structures.',
         '- Root-only means exactly one initial member and no SPAWN event. A spawned member can remain unexecuted. Multiple executed shapes can reflect the coordinator versus executor, not necessarily multiple specialist subagents.',
         '- Tool creation attempts count observed `create_tool` calls; direct programmatic registration need not issue such a call. Registrations, successful calls, and successful calls by another agent are separate. Missing registries/usage fields are unknown, not zero. Top-level calls do not double-count internal dependencies of a generated composite tool.',
         '- Explicit evidence-edge and cross-agent node-dependency counts are lower bounds on communication: string/message evidence can be routed without either event. They do not measure whether evidence was understood or improved the answer.',
         '- Exact per-edit branch trigger IDs were not instrumented. Feature occurrences are reported; they cannot be assigned causally to individual code edits. A generated program binding does not alone prove a novel subagent or graph.',
         '- Known search tokens sum the retained per-task usage ledgers plus optimizer usage, including incomplete rounds and failed attempts whose usage is recorded. Unknown calls are separate. Archived ledgers outside the audited lineage are not silently added or discarded; historical lineages are separate. Cached tokens are still tokens, not equal monetary charges.',
         '- Active remote files were read during the audit and are not an atomic experiment snapshot. Stopped historical versions and incomplete HLE remain unchanged. BFCL R29 is a test-observed supplementary choice; R31 is the search-selected final candidate.',
         '', '## Search summary','',
         '| Lineage | Role | Full / observed rounds | R1 search | Best completed search | Selected round | Known search tokens | Unknown calls |',
         '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |']
    for run in runs:
        s=run['search'];rr=s.get('rounds',[]);done=[r for r in rr if r['complete']];first=next((r for r in done if r['round']==1),None);best=max(done,key=lambda r:r['score']) if done else None
        cost=s.get('usage',{});total=cost.get('knownTokens',0)+cost.get('optimizerKnownTokens',0);unknown=cost.get('unknownCalls',0)+cost.get('optimizerUnknownCalls',0)
        selected=s.get('summary',{}).get('selectedRound');run['selectedRound']=selected
        doc.append(f"| {run['id']} | {run['role']} | {len(done)} / {len(rr)} | {pct(first['score'] if first else None)} | {pct(best['score'] if best else None)} | {num(selected)} | {tokens(total) if s.get('available') else '—'} | {unknown if s.get('available') else '—'} |")
        for r in rr:
            c=r['changes'];m=r['mechanisms'];paired=r['pairedWithParent'];cats=categories(r)
            row={'lineage':run['id'],'benchmark':run['benchmark'],'round':r['round'],'parent':r['parent'],'status':r['status'],'completedEpisodes':m['episodes'],'expectedEpisodes':run['count']*run.get('repeats',5),'searchScore':r['score'],'partialObservedScore':r['partialObservedScore'],'parentPairedDelta':paired.get('meanDelta'),'improvedTasks':paired.get('improved'),'regressedTasks':paired.get('regressed'),'pairedTasks':paired.get('tasks'),'executionErrorRows':r['executionErrorRows'],'roundKnownTokens':r['roundKnownTokens'],'cumulativeKnownTokens':r['cumulativeKnownTokens'],'cumulativeUnknownCalls':r['cumulativeUnknownCalls'],'categories':';'.join(cats),'addedTemplates':';'.join(c.get('addedTemplates',[])),'removedTemplates':';'.join(c.get('removedTemplates',[])),'changedPrograms':';'.join(sorted(c.get('changedTemplatePrograms',[]))),'changedProfiles':';'.join(sorted(c.get('changedProfiles',[]))),'normalizedLibraryChanged':c.get('normalizedLibraryChanged'),'auditContentHash':r.get('auditContentHash'),'artifactSource':r.get('artifactSource'),'sameAsParentIgnoringId':r.get('sameAsParentIgnoringId'),'sameAsEarlierRoundIgnoringId':r.get('sameAsEarlierRoundIgnoringId')}
            round_rows.append(row)
            row['reviewedEngineeringFault']=r.get('reviewedEngineeringFault')
            for cat in cats:
                parent=next((x for x in rr if x['round']==r['parent']),{})
                if paired and not fault_affected(r) and not fault_affected(parent):
                    category_rows.append({'lineage':run['id'],'category':cat,'round':r['round'],'parent':r['parent'],'scoreDelta':paired['meanDelta'],'roundKnownTokens':r['roundKnownTokens'],'parentRoundKnownTokens':parent.get('roundKnownTokens'),'spawnedEpisodeChange':m.get('spawnedEpisodes',0)-parent.get('mechanisms',{}).get('spawnedEpisodes',0)})
            search_rows.append(mechanism_row(run['id'],str(r['round']),m))
        identity_rows.append({'lineage':run['id'],'observedRounds':len(rr),'contentAvailable':sum(bool(r.get('auditContentHash')) for r in rr),'distinctPayloadsIgnoringId':len({r['auditContentHash'] for r in rr if r.get('auditContentHash')}),'sameAsParentIgnoringId':sum(r.get('sameAsParentIgnoringId') is True for r in rr),'sameAsEarlierIgnoringId':sum(r.get('sameAsEarlierRoundIgnoringId') is not None for r in rr),'repeatRoundKnownTokens':sum(r['roundKnownTokens'] for r in rr if r.get('sameAsEarlierRoundIgnoringId') is not None)})
        for name,t in run['tests'].items():
            if not t.get('available'):continue
            m=t['mechanisms'];test_rows.append({'lineage':run['id'],'variant':name,'count':t['count'],'uniqueTasks':t['uniqueTasks'],'taskIdsHash':t['taskIdsHash'],'accuracy':t['accuracy'],'meanF1':t['meanF1'],'knownTokens':(t.get('usage') or {}).get('knownTokens'),'unknownCalls':(t.get('usage') or {}).get('unknownCalls'),**mechanism_row(run['id'],name,m)})
    doc+=['','## Identical candidate audit','',
          'Repeated candidates may legitimately estimate variance, but their score changes cannot establish a new structural improvement. Repeatedly choosing the largest observed mean also creates selection optimism. This audit does not infer why the optimizer emitted or retained the same payload.','',
          f"Frozen candidate verification: {len(identities)} candidates checked; {sum(x['passManifests'] for x in identities)} pass manifests; {sum(not x['allPassHashesMatch'] for x in identities)} mismatches or candidates without manifest evidence. See `manifest-verification.csv`.",'',
          '| Lineage | Observed rounds | Distinct payloads | Same as parent | Same as any earlier round | Known tokens in repeated rounds |',
          '| --- | ---: | ---: | ---: | ---: | ---: |']
    for r in identity_rows:
        doc.append(f"| {r['lineage']} | {r['observedRounds']} | {r['distinctPayloadsIgnoringId']} | {r['sameAsParentIgnoringId']} | {r['sameAsEarlierIgnoringId']} | {tokens(r['repeatRoundKnownTokens'])} |")
    doc+=['','## Test mechanism summary','',
          '| Lineage / variant | Tasks | Accuracy / F1 | Root-only / observed | Spawn events | Created tools | Successful generated-tool calls | Cross-agent generated-tool calls |',
          '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |']
    for r in test_rows:
        doc.append(f"| {r['lineage']} / {r['variant']} | {r['count']} | {pct(r['accuracy'])} / {pct(r['meanF1'])} | {num(r['rootOnlyEpisodes'])} / {r['lifecycleObserved']} | {num(r['spawnEvents'])} | {num(r['registeredGeneratedTools'])} | {num(r['successfulGeneratedToolCalls'])} | {num(r['crossAgentGeneratedToolCalls'])} |")
    doc+=['','## Lineage trees, parent comparisons, and cost curves','',
          'Blue curves show complete candidate means with SD across validation passes; green curves show the best completed mean. Red markers identify recorded execution errors or reviewed interface faults; purple squares identify the same payload as the parent. A dotted green tail extends the previous best through incomplete-round costs without assigning a score to that round. Tree edges are recorded parent relations. Disconnected nodes mean parent evidence is absent, not independent initialization.','']
    for run in runs:
        rr=run['search'].get('rounds',[])
        if not rr:continue
        doc+=['### '+run['id'],'','```mermaid',tree(run,figs).strip(),'```','']
        if curve(run,figs):doc += [f"![Search curve](figures/{run['id']}-curve.png)",'']
        doc+=['| Round ← parent | Complete search | Δ vs parent | Improved / regressed tasks | Artifact changes | Fault rows |', '| --- | ---: | ---: | ---: | --- | ---: |']
        for r in rr:
            p=r['pairedWithParent'];d=p.get('meanDelta');delta='—' if d is None else f'{d*100:+.2f} pp'
            fault_note=str(r['executionErrorRows'])+(' + reviewed interface fault' if r.get('reviewedEngineeringFault') else '')
            doc.append(f"| R{r['round']} ← {num(r['parent'])} | {pct(r['score'])} | {delta} | {num(p.get('improved'))} / {num(p.get('regressed'))} | {', '.join(categories(r))} | {fault_note} |")
        doc.append('')
    doc+=['## Reproduction and files','',
          '`scripts/audit_mechanisms.py --spec <private-run-paths.json> --out <private-audit.json>` reads frozen search/test records. The spec is a list of `id`, `benchmark`, `model`, `role`, `count` (search tasks), `repeats`, `search` directory, and named `tests` directories. `--spec-json` supports remote read-only collection over SSH. It does not import agents or providers.','',
          '`uv run --with matplotlib python scripts/render_mechanism_audit.py --input <local.json> <remote.json> --out <report-directory>` creates this aggregate report. Private source paths, prompts, reference answers, model responses, and optimizer descriptions are not exported.','',
          '`node scripts/verify_audit_identities.mjs <private-run-paths.json> > <identities.json>` verifies frozen candidates against retained pass manifests using the application digest (requires the built application). Supply `--identities <identities.json>` to the renderer to include this cross-check.','',
          'Supply `--reviewed-faults <report-directory>/reviewed-faults.json` to reproduce the manually reviewed engineering-fault annotations. These annotations do not rewrite task outcomes.','',
          '- `rounds.csv`: actual parents, score changes, artifact component changes, faults, and known cumulative tokens.',
          '- `search-mechanisms.csv`: full and partial round execution counts with coverage denominators.',
          '- `test-mechanisms.csv`: realized mechanisms for each available test/ablation.',
          '- `category-associations.csv`: clean complete parent-child comparisons, multi-label and observational.',
          '- `category-summary.csv`: aggregate associations; identity-only repeats are explicitly separate from changes.',
          '- `candidate-identities.csv` and `manifest-verification.csv`: repeat counts and executed candidate checks.',
          '- `figures/`: Mermaid tree sources and PNG/SVG/PDF curves.',
          '', 'Plot provenance: adapted from data-viz Figure 04. Its palette, main axes proportions, and line/errorbar encoding are retained; biological phase shading, insets, demo data, and significance annotations are removed. Score uncertainty is repeated-pass SD, not confidence intervals or independent-task replication.','']
    (a.out/'README.md').write_text('\n'.join(doc))
    grouped=collections.defaultdict(list)
    for r in category_rows:grouped[(r['lineage'],r['category'])].append(r)
    category_summary=[]
    for (lineage,cat),rows in grouped.items():
        ratios=[r['roundKnownTokens']/r['parentRoundKnownTokens'] for r in rows if r.get('parentRoundKnownTokens')]
        category_summary.append({'lineage':lineage,'category':cat,'cleanComparisons':len(rows),'improved':sum(r['scoreDelta']>1e-10 for r in rows),'regressed':sum(r['scoreDelta']< -1e-10 for r in rows),'unchanged':sum(abs(r['scoreDelta'])<=1e-10 for r in rows),'medianScoreDelta':statistics.median(r['scoreDelta'] for r in rows),'medianCostRatio':statistics.median(ratios) if ratios else None,'spawnedEpisodeDeltaSum':sum(r['spawnedEpisodeChange'] for r in rows)})
    for name,rows in [('rounds',round_rows),('search-mechanisms',search_rows),('test-mechanisms',test_rows),('category-associations',category_rows),('category-summary',category_summary),('candidate-identities',identity_rows),('manifest-verification',identities)]:write_csv(a.out/(name+'.csv'),rows)
    print(json.dumps({'lineages':len(runs),'rounds':len(round_rows),'testVariants':len(test_rows),'out':str(a.out)}))


def mechanism_row(lineage,phase,m):
    x={'lineage':lineage,'phase':phase,'episodes':m['episodes']}
    for k in ['organizationObserved','lifecycleObserved','programRegistryObserved','toolRegistryObserved','toolUsageObserved','distinctTypedGraphShapes','distinctSpawnTreeShapes']:
        x[k]=m.get(k,0)
    fields={
      'lifecycleObserved':['rootOnlyEpisodes','multipleInitialEpisodes','spawnedEpisodes','spawnEvents','recursiveSpawnEpisodes','outsideTemplateSpawnEvents','multipleExecutedShapeEpisodes','executedMemberTotal','crossAgentDependencyEpisodes','crossAgentDependencyEdges'],
      'programRegistryObserved':['generatedProgramBindings','generatedProgramEpisodes','distinctGeneratedSourceHashes'],
      'toolRegistryObserved':['registeredGeneratedTools','generatedToolEpisodes','inheritedLibraryRegistrations'],
      'toolUsageObserved':['createToolAttempts','createToolSuccessObservations','successfulGeneratedToolCalls','successfulGeneratedToolEpisodes','crossAgentGeneratedToolCalls','crossAgentGeneratedToolEpisodes'],
      'organizationObserved':['toolObservations','nodeFailureEpisodes','explicitEvidenceEdges']}
    for coverage,keys in fields.items():
        for k in keys:x[k]=measured(m,k,coverage)
    if not m.get('toolRegistryObserved') or not m.get('toolUsageObserved'):
        for k in ['successfulGeneratedToolCalls','successfulGeneratedToolEpisodes','crossAgentGeneratedToolCalls','crossAgentGeneratedToolEpisodes']:x[k]=None
    for k in ['spawnTemplates','nodeFailures','toolOutcomes','depthDistribution']:x[k]=json.dumps(m.get(k,{}),sort_keys=True)
    return x


if __name__=='__main__':main()
