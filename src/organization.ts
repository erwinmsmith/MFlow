import type { Execution } from './types.js';

/** Search feedback describes the organization actually executed, including routing failures. */
export function organizationEvidence(execution: Execution) {
  const last = execution.trace.at(-1)?.state;
  const actions: Record<string, number> = {};
  const noops: Record<string, number> = {};
  for (const step of execution.trace) {
    actions[step.decision.action] = (actions[step.decision.action] ?? 0) + 1;
    if (step.event.includes(':')) noops[step.event] = (noops[step.event] ?? 0) + 1;
  }
  const native = execution.orchestration;
  for (const change of native?.lifecycle ?? [])
    actions[change.action] = (actions[change.action] ?? 0) + 1;
  const graphs = native?.graphs.map(({ id, nodes }) => ({ id, nodes }));
  const nodeCalls: Record<string, number> = {};
  const nodeFailures: Record<string, number> = {};
  for (const graph of graphs ?? []) for (const node of graph.nodes)
    nodeCalls[node.type] = (nodeCalls[node.type] ?? 0) + 1;
  for (const graph of native?.graphs ?? []) for (const node of graph.nodes) {
    const result = (graph.outputs as Record<string, { status?: string; error?: { code?: string } }>)[node.id];
    if (result?.status === 'error' || result?.status === 'failed') {
      const key = `${node.type}:${result.error?.code ?? 'UNKNOWN'}`;
      nodeFailures[key] = (nodeFailures[key] ?? 0) + 1;
    }
  }
  return {
    agents: execution.agents, actions, noops,
    ...(native ? { graphs, nodeCalls, nodeFailures, lifecycle: native.lifecycle, programs: native.programs, tools: native.tools, toolUsage: native.toolCalls, decisions: native.decisions,
      executedAgents: [...new Set(native.graphs.flatMap(g => g.nodes.map(n => n.id.split('/')[0])))],
      publishedAnswers: execution.outputs.map(o => ({ agentId: o.agentId, answer: o.output.candidate_answer })),
    } : {}),
    edges: execution.edges.map(({ source, target, deficitId }) => ({ source, target, deficitId })),
    transitions: execution.trace.map(({ state, decision, event }) => ({
      action: decision.action, agentId: decision.agentId, deficitId: decision.deficitId, event,
      activeAgents: state.agents.filter(a => a.status === 'ACTIVE').map(a => a.id),
      edges: (state.edges ?? []).map(({ source, target, deficitId }) => ({ source, target, deficitId })),
      ...(decision.profile ? { profile: decision.profile } : {}),
    })),
    deficits: (last?.deficits ?? []).map(d => ({ id: d.id, owner: d.owner, source: d.source,
      status: d.status, artifacts: d.artifactIds.length, delivered: d.deliveredIds.length })),
    peakActive: execution.peakActive, depth: execution.depth, toolCalls: execution.toolEvents.length,
    stopReason: execution.stopReason, stopDetail: execution.stopDetail,
  };
}

export function summarizeOrganizations(rows: { taskId: string; score: number; organization?: ReturnType<typeof organizationEvidence> }[]) {
  const actions: Record<string, number> = {}, noops: Record<string, number> = {};
  const examples: typeof rows = [];
  const patterns = new Set<string>();
  const programs = new Map<string, unknown>(), tools = new Map<string, unknown>();
  const templateUsage: Record<string, { runs: number; tasks: number; correctTasks: number }> = {};
  const nodeFailures: Record<string, number> = {};
  let spawnedTasks = 0, unroutedTasks = 0;
  for (const row of rows) {
    const org = row.organization;
    if (!org) continue;
    for (const [key, count] of Object.entries(org.nodeFailures ?? {})) nodeFailures[key] = (nodeFailures[key] ?? 0) + count;
    for (const [k, n] of Object.entries(org.actions)) actions[k] = (actions[k] ?? 0) + n;
    for (const [k, n] of Object.entries(org.noops)) noops[k] = (noops[k] ?? 0) + n;
    if (org.actions.DERIVE || org.actions.CHALLENGE || org.actions.SPAWN) spawnedTasks++;
    const used = new Set<string>();
    for (const event of org.lifecycle ?? []) {
      if (event.action !== 'RUN_TEMPLATE' || !event.templateId) continue;
      const usage = templateUsage[event.templateId] ??= { runs: 0, tasks: 0, correctTasks: 0 };
      usage.runs++; used.add(event.templateId);
    }
    for (const id of used) { templateUsage[id].tasks++; templateUsage[id].correctTasks += row.score; }
    if (org.deficits.some(d => d.artifacts > d.delivered && d.status !== 'RESOLVED')) unroutedTasks++;
    const shape = (agentId?: string) => [...new Set((org.graphs ?? []).flatMap(g=>g.nodes
      .filter(n=>!agentId || n.id.split('/')[0]===agentId)
      .map(n=>JSON.stringify([n.type,n.dependencies.map(d=>[g.nodes.find(p=>p.id===d)?.type,d.split('/')[0]!==n.id.split('/')[0]])]))))].sort();
    const features = new Set([`outcome:${row.score}`, `topology:${row.score}:${JSON.stringify(shape())}`,
      ...Object.keys(org.nodeFailures ?? {}).map(k=>'error:'+k),
      ...(org.programs?.length ? [`generated-program:${row.score}`] : []),
      ...(org.tools?.length ? [`created-tool:${row.score}`] : []),
      ...(org.decisions ?? []).map(d=>'decision:'+JSON.stringify(d.decision && typeof d.decision==='object' && 'stop' in d.decision ? d.decision.stop : null)),
    ]);
    for (const program of org.programs ?? []) {
      const profile = org.agents.find(a=>a.id===program.agentId), topology=shape(program.agentId);
      const signature = JSON.stringify([topology,profile?.reasoning,[...(profile?.tools ?? [])].sort()]);
      if (row.score && topology.length && !programs.has(signature)) programs.set(signature,
        { taskId:row.taskId, score:row.score, ...program, profile, topology });
    }
    for (const tool of org.tools ?? []) {
      const uses=(org.toolUsage ?? []).filter(c=>c.name===tool.definition.name && c.status==='success');
      if (uses.some(c=>c.agentId!==tool.creatorId)) features.add(`tool-sharing:${row.score}`);
      if (uses.length && !tools.has(tool.hash)) tools.set(tool.hash,{ taskId:row.taskId, score:row.score, ...tool, uses });
    }
    // Evidence coverage, not input order: later generated graphs/tool use must reach the optimizer.
    if ([...features].some(k=>!patterns.has(k))) { for(const k of features)patterns.add(k); examples.push(row); }
  }
  return { evaluated: rows.length, correct: rows.reduce((n, r) => n + r.score, 0),
    actions, noops, spawnedTasks, unroutedTasks, templateUsage, nodeFailures, examples,
    reusableCandidates: { programs:[...programs.values()], tools:[...tools.values()],
      note:'Search execution evidence only. Task score is not causal proof of artifact quality. Generalize task-specific values away, explicitly promote useful artifacts into the candidate, then evaluate; never copy answers or episode state.' } };
}
