#!/usr/bin/env python3
"""Visualize existing aggregate evidence; no agent/provider imports or model calls.

Adapted directly from data-viz figure19/plot.py (aligned dumbbells, bubbles,
horizontal bars) and figure07/plot.py + vizlib/common.py:grouped_bars.
Unmeasured sample/error layers and biological annotations are removed.
"""
import argparse
from collections import Counter
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.colors import LinearSegmentedColormap, Normalize
from matplotlib.lines import Line2D
from matplotlib.patches import Patch
import numpy as np

CASES = [
    ('MATH', 'deepseek_math_v8', 'selected_R2', 'R2'),
    ('DROP', 'deepseek_drop', 'selected', 'R26'),
    ('MBPP', 'deepseek_mbpp', 'selected', 'R7'),
    ('BFCL', 'deepseek_bfcl', 'supplementary_R29', 'R29'),
    ('AutomationBench', 'deepseek_automation_v11', 'frozen_R3_supplementary', 'v11 R3'),
]
COLORS = ['#383838', '#e8a625', '#58a3ad']


def read(path):
    with path.open() as f:
        return list(csv.DictReader(f))


def export(path, rows):
    with path.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]), lineterminator='\n')
        w.writeheader(); w.writerows(rows)


def clean(ax, full=False):
    for name, spine in ax.spines.items():
        spine.set_visible(full or name in ['left', 'bottom'])
        spine.set_color('#999')
    ax.tick_params(length=0)


class Canvas:
    # Pixel-coordinate canvas retained from the template Figure helper.
    def __init__(self, width, height):
        self.width, self.height = width, height
        self.fig = plt.figure(figsize=(width / 100, height / 100), dpi=150, facecolor='white')

    def ax(self, box):
        x, y, w, h = box
        return self.fig.add_axes([x/self.width, 1-(y+h)/self.height, w/self.width, h/self.height])

    def text(self, x, y, text, **kw):
        return self.fig.text(x/self.width, 1-y/self.height, text, **kw)

    def save(self, out, name):
        for ext in ['png', 'svg', 'pdf']:
            self.fig.savefig(out/f'{name}.{ext}', metadata={'Creator': 'MFlow offline mechanism visualization'})
        svg = out/f'{name}.svg'
        svg.write_text('\n'.join(line.rstrip() for line in svg.read_text().splitlines())+'\n')
        plt.close(self.fig)


def prepare(source, out):
    rounds, tests, search = [read(source/f'{name}.csv') for name in ['rounds', 'test-mechanisms', 'search-mechanisms']]
    overview, members, tools = [], [], []
    for name, lineage, variant, tested_round in CASES:
        rr = [r for r in rounds if r['lineage'] == lineage and r['searchScore']]
        seed = next(r for r in rr if r['round'] == '1')
        best = max(rr, key=lambda r: float(r['searchScore']))
        t = next(r for r in tests if r['lineage'] == lineage and r['variant'] == variant)
        n = int(t['count'])
        assert n == int(t['uniqueTasks']) == int(t['lifecycleObserved'])
        single, spawned = int(t['rootOnlyEpisodes']), int(t['spawnedEpisodes'])
        assert single + spawned == n
        counts = json.loads(t['spawnTemplates'])
        assert sum(counts.values()) == int(t['spawnEvents'])
        overview.append(dict(benchmark=name, lineage=lineage, testVariant=variant, testRound=tested_round,
                             searchR1=100*float(seed['searchScore']), searchBest=100*float(best['searchScore']),
                             searchBestRound=int(best['round']), metric='F1' if name=='DROP' else 'Accuracy',
                             testTasks=n, singleTasks=single, spawnedTasks=spawned,
                             singlePercent=100*single/n, spawnedPercent=100*spawned/n,
                             spawnEvents=int(t['spawnEvents']), meanSpawnEvents=int(t['spawnEvents'])/n))
        for member, count in counts.items():
            members.append(dict(benchmark=name, testRound=tested_round, member=member, spawnEvents=count,
                                shareOfSpawnEvents=100*count/int(t['spawnEvents'])))
        fields = ['registeredGeneratedTools', 'successfulGeneratedToolCalls', 'crossAgentGeneratedToolCalls']
        sr = [r for r in search if r['lineage'] == lineage]
        for stage, obs in [('Search', sr), ('Test', [t])]:
            # Never turn legacy missing tool fields into zeros.
            available = any(r[f] != '' for r in obs for f in fields)
            tools.append(dict(benchmark=name, stage=stage, episodes=sum(int(r['episodes']) for r in obs),
                              registryEpisodes=sum(int(r['toolRegistryObserved']) for r in obs),
                              usageEpisodes=sum(int(r['toolUsageObserved']) for r in obs),
                              **{f:sum(int(r[f]) for r in obs if r[f] != '') if available else None for f in fields}))
    export(out/'overview.csv', overview); export(out/'members.csv', members); export(out/'tools.csv', tools)
    return overview, members, tools


def extract_member_coverage(spec_path, out):
    """Count each template at most once per task; raw task content stays private."""
    specs = {r['id']: r for r in json.loads(spec_path.read_text())}
    result = []
    for name, lineage, variant, _ in CASES:
        root = Path(specs[lineage]['tests'][variant])
        source = root/'test.jsonl'
        present, events, seen = Counter(), Counter(), set()
        with source.open() as f:
            for line in f:
                if not line.strip():
                    continue
                r = json.loads(line)
                task = r['taskId']
                if task in seen:
                    raise ValueError(f'Duplicate task ID in {name}')
                seen.add(task)
                org = r.get('organization') or (r.get('execution') or {}).get('orchestration')
                if org is None or org.get('lifecycle') is None:
                    raise ValueError(f'Missing lifecycle evidence in {name}')
                spawned = [e.get('templateId') or '<generated-profile>' for e in org['lifecycle'] if e.get('action') == 'SPAWN']
                events.update(spawned)
                present.update(set(spawned))
        for member in sorted(events):
            result.append(dict(benchmark=name, member=member, testTasks=len(seen),
                               tasksWithMember=present[member], taskCoveragePercent=100*present[member]/len(seen),
                               spawnEvents=events[member]))
    export(out/'member-task-coverage.csv', result)


def overview_plot(rows, out):
    # Figure 19 panel order, x positions, palette, and layering are retained.
    # Height is reduced for five benchmark rows instead of 36 cell types.
    c = Canvas(1026, 442)
    ax = c.ax([190, 30, 482, 332])
    expr = c.ax([686, 30, 184, 332])
    bar = c.ax([881, 30, 116, 332])
    ys = np.arange(len(rows))
    for aa in [ax, expr, bar]:
        clean(aa, True); aa.set_ylim(len(rows)-.45, -1.15); aa.set_yticks(ys)
    labels = [r['benchmark'] for r in rows]
    ax.set_yticklabels(labels, fontsize=11)
    ax.set_xlim(65, 102); ax.set_xticks([70,80,90,100])
    ax.grid(axis='x', color='#e9e9e9', ls=(0,(2,7)), lw=.7)
    initial = np.array([r['searchR1'] for r in rows]); best = np.array([r['searchBest'] for r in rows])
    ax.hlines(ys, initial, best, color='#999', lw=1.3)
    ax.scatter(initial, ys, c='black', s=36, zorder=3)
    ax.scatter(best, ys, c='#8cbbb0', edgecolors='#46665e', s=40, zorder=4)
    for y, r in enumerate(rows):
        ax.text(66, y-.24, f"{r['searchR1']:.2f} → {r['searchBest']:.2f}%  (+{r['searchBest']-r['searchR1']:.2f} pp)", fontsize=10)
    ax.set_title('A  Search outcomes', loc='left', fontsize=15, pad=5)
    ax.set_xlabel('Search accuracy / DROP F1 (%)', fontsize=12, labelpad=10)
    expr.set_title('B  Test routing', fontsize=15, pad=5)
    expr.set_xlim(-.5,1.5); expr.set_yticklabels([])
    expr.set_xticks([0,1],['Single','Spawned'], fontsize=11)
    for y, r in enumerate(rows):
        for x, field, color in [(0,'singlePercent','#d5d5d2'),(1,'spawnedPercent','#81b2c4')]:
            value=r[field]
            expr.scatter(x,y-.18,s=value/100*500,c=color,edgecolors='#777',lw=.7,zorder=3)
            expr.text(x,y+.30,f'{value:.1f}%',ha='center',va='center',fontsize=10)
    bar.set_title('C  Spawning', fontsize=15,pad=5)
    bar.set_yticklabels([]); bar.set_xlim(0,4.6); bar.set_xticks([0,2,4])
    bar.grid(axis='x',color='#eee',ls=(0,(2,5)),lw=.7)
    for i,r in enumerate(rows):
        bar.barh(i,r['meanSpawnEvents'],.32,color='#9dc9d8',edgecolor='none',zorder=3)
        bar.text(r['meanSpawnEvents']+.1,i,f"{r['meanSpawnEvents']:.2f}",va='center',fontsize=10)
    bar.set_xlabel('Children\nper test task',fontsize=11,labelpad=10)
    ax.legend([Line2D([],[],marker='o',ls='',color='black'),Line2D([],[],marker='o',ls='',color='#8cbbb0')],
              ['R1 search mean','Best completed search mean'],loc='upper left',frameon=False,ncol=2,fontsize=10,
              handletextpad=.4,columnspacing=1.2)
    c.save(out,'01-search-and-adaptation')


def member_plot(rows, overview, out):
    # Reuse Figure 19's categorical bubble matrix and area encoding.
    # Auxiliary panels are removed; the matrix reclaims their horizontal space.
    c = Canvas(1026,466); ax = c.ax([190,16,807,320]); clean(ax,True)
    coverage = {(r['benchmark'],r['member']):r for r in read(out/'member-task-coverage.csv')}
    assert set(coverage) == {(r['benchmark'],r['member']) for r in rows}
    totals = {r['benchmark']:r['testTasks'] for r in overview}
    cmap = LinearSegmentedColormap.from_list('coverage', ['#edf3f2','#99c5bc','#286e67'])
    norm = Normalize(0,100)
    roles=['Single only','reviewer','independent','checker','solver','calculator','normalizer','span_extractor','oracle_probe','turn_runner','verifier','<generated-profile>']
    labels=[r['benchmark'] for r in overview]; ys=np.arange(len(labels))
    ax.set_ylim(len(labels)-.5,-1.1); ax.set_yticks(ys,labels,fontsize=11)
    ax.set_xlim(-.7,len(roles)-.3)
    ax.set_xticks(range(len(roles)),[x.replace('_',' ') if x!='<generated-profile>' else 'Custom profile*' for x in roles],rotation=55,ha='right',fontsize=11)
    ax.grid(color='#e9e9e9',ls=(0,(2,7)),lw=.7,zorder=0)
    ax.axvline(.5,color='#ccc',lw=.7,zorder=1)
    for y,r in enumerate(overview):
        count = r['singleTasks']
        value = 100*count/r['testTasks']
        if count:
            ax.scatter(0,y-.17,s=value/100*550,c=[cmap(norm(value))],edgecolors='#777',lw=.7,zorder=3)
        else:
            ax.scatter(0,y-.17,s=180,facecolors='white',edgecolors='#888',lw=1,linestyles=(0,(2,2)),zorder=3)
        ax.text(0,y+.33,str(count),ha='center',va='center',fontsize=11)
    for r in rows:
        x,y=roles.index(r['member']),labels.index(r['benchmark'])
        evidence = coverage[(r['benchmark'],r['member'])]
        assert int(evidence['testTasks']) == totals[r['benchmark']]
        assert int(evidence['spawnEvents']) == r['spawnEvents']
        assert 0 < int(evidence['tasksWithMember']) <= min(r['spawnEvents'],int(evidence['testTasks']))
        value = float(evidence['taskCoveragePercent'])
        assert abs(value-100*int(evidence['tasksWithMember'])/int(evidence['testTasks'])) < 1e-8
        ax.scatter(x,y-.17,s=r['shareOfSpawnEvents']/100*550,c=[cmap(norm(value))],edgecolors='#777',lw=.7,zorder=3)
        ax.text(x,y+.33,str(r['spawnEvents']),ha='center',va='center',fontsize=11)
    # Keep the quantitative color key inside the existing panel; no extra panel.
    key = ax.inset_axes([.58,.88,.37,.028])
    c.fig.colorbar(matplotlib.cm.ScalarMappable(norm=norm,cmap=cmap),cax=key,orientation='horizontal',ticks=[0,50,100])
    key.set_xticklabels(['0%','50%','100%']); key.tick_params(labelsize=8,length=2,pad=1)
    ax.text(.58,.925,'Test-task coverage',transform=ax.transAxes,fontsize=9,va='bottom')
    c.save(out,'02-spawned-members')


def tool_plot(rows,out):
    # Figure 07 grouped bars; the legend moves inside to reclaim unused space.
    # Provided counts replace means; unmeasured samples/error bars are omitted.
    c=Canvas(1026,451); ax=c.ax([84,16,918,345]); clean(ax)
    observed=[r for r in rows if r['registeredGeneratedTools'] is not None]
    groups=['Registered','Successful calls','Cross-agent calls']
    fields=['registeredGeneratedTools','successfulGeneratedToolCalls','crossAgentGeneratedToolCalls']
    width,spacing=.72,3.85
    for i,r in enumerate(observed):
        for j,(field,color) in enumerate(zip(fields,COLORS)):
            x=i*spacing+j; value=r[field]
            ax.bar(x,value,width,fc=color,ec='#333',lw=.9,zorder=3)
            ax.text(x,value+.8,str(value),ha='center',va='bottom',fontsize=9)
    ax.set_xlim(-1,(len(observed)-1)*spacing+len(groups))
    ax.set_ylim(0,72); ax.set_ylabel('Observed count',fontsize=15)
    names=[r['benchmark'].replace('AutomationBench','AutoBench')+f"\n{r['stage']}" for r in observed]
    ax.set_xticks(np.arange(len(observed))*spacing+1,names,fontsize=9)
    ax.tick_params(axis='x',pad=10); ax.grid(False)
    ax.legend([Patch(fc=cc,ec='#555',lw=.9) for cc in COLORS],groups,title='Generated tools',
                 loc='upper right',frameon=False,fontsize=11,title_fontsize=12,
                 handlelength=1.2,labelspacing=.7,handletextpad=.5)
    c.save(out,'03-generated-tools')


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',type=Path,default=Path('docs/experiments/mechanism-audit-2026-10-12'))
    p.add_argument('--members-only',action='store_true',help='Render only the member figure')
    p.add_argument('--run-spec',type=Path,help='Optional private run spec to refresh per-task member coverage')
    a=p.parse_args(); out=a.source/'visuals'; out.mkdir(exist_ok=True)
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':12,'axes.linewidth':1.3,'svg.fonttype':'none','pdf.fonttype':42})
    overview,members,tools=prepare(a.source,out)
    if a.run_spec:
        extract_member_coverage(a.run_spec,out)
    member_plot(members,overview,out)
    if not a.members_only:
        overview_plot(overview,out); tool_plot(tools,out)
    print(f'Rendered {1 if a.members_only else 3} figures (PNG/SVG/PDF) in {out}')


if __name__=='__main__':main()
