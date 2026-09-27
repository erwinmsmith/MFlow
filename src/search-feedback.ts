import type { SearchNode } from "./search.js";
import type { Evaluated } from "./types.js";
import { mean } from "./util.js";

/** Measured validation behavior only. Incomplete evaluations never get a full score. */
export function behavior(results: Evaluated[]) {
  const stops: Record<string, number> = {};
  let spawned = 0, unintegrated = 0;
  for (const { execution: e } of results) {
    const reason = e.stopDetail ?? e.stopReason;
    stops[reason] = (stops[reason] ?? 0) + 1;
    const firstChild = e.outputs.findIndex((o) => o.agentId !== "root");
    if (e.agents.length > 1) {
      spawned++;
      if (firstChild < 0 || !e.outputs.slice(firstChild + 1).some((o) => o.agentId === "root")) unintegrated++;
    }
  }
  return {
    count: results.length,
    meanLogicalTokens: mean(results.map((r) => r.execution.tokens)),
    actualTokens: results.reduce((n, r) => n + r.execution.actualTokens, 0),
    spawnedTasks: spawned, spawnWithoutRootIntegration: unintegrated, stops,
  };
}

export function experience(node: SearchNode, nodes: SearchNode[]) {
  const parent = nodes.find((n) => n.id === node.parent);
  const baseline = new Map(parent?.results.map((r) => [r.taskId, r.score]));
  let corrected = 0, harmed = 0, paired = 0;
  for (const r of node.results) {
    const before = baseline.get(r.taskId);
    if (before === undefined) continue;
    paired++;
    if (r.score > before) corrected++;
    if (r.score < before) harmed++;
  }
  const complete = node.status === "evaluated" && node.utility !== undefined;
  return {
    id: node.id, parent: node.parent, edit: node.mutation?.description,
    status: node.status, complete, feasible: node.feasible,
    accuracy: complete ? node.utility : undefined,
    delta: complete && parent?.utility !== undefined ? node.utility! - parent.utility : undefined,
    paired: { count: paired, corrected, harmed },
    behavior: behavior(node.results), reason: node.reason,
  };
}

/** AFlow-style parent-local trials plus the complete ancestral chain. */
export function searchExperience(parent: SearchNode, nodes: SearchNode[]) {
  const lineage: ReturnType<typeof experience>[] = [];
  for (let n: SearchNode | undefined = parent; n; n = nodes.find((x) => x.id === n!.parent))
    lineage.unshift(experience(n, nodes));
  const children = nodes.filter((n) => n.parent === parent.id);
  return {
    lineage,
    parentTrials: children.map((n) => experience(n, nodes)),
    otherRecentTrials: nodes.filter((n) => n.parent && n.parent !== parent.id && !lineage.some((a) => a.id === n.id))
      .slice(-5).map((n) => experience(n, nodes)),
  };
}

/** Equal top-k validation means over complete candidates, as in AFlow (z=0). */
export function stableTopScores(history: number[], patience: number): boolean {
  const tail = history.slice(-(patience + 1));
  return tail.length === patience + 1 && tail.every((x) => Math.abs(x - tail[0]) < 1e-12);
}
