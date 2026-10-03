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
    ...(native ? { graphs, nodeCalls, nodeFailures, lifecycle: native.lifecycle, programs: native.programs, tools: native.tools,
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
    const pattern = JSON.stringify([row.score, org.transitions.map(t => t.action), org.edges, org.graphs, org.lifecycle]);
    if (!patterns.has(pattern) && examples.length < 6) { patterns.add(pattern); examples.push(row); }
  }
  return { evaluated: rows.length, correct: rows.reduce((n, r) => n + r.score, 0),
    actions, noops, spawnedTasks, unroutedTasks, templateUsage, nodeFailures, examples };
}
