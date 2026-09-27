import {
  actions,
  type Action,
  type Decision,
  type Deficit,
  type PolicyState,
  type Rule,
  type Strategy,
  strategySchema,
} from "./types.js";
import { canonical, digest } from "./util.js";

function matches(
  rule: Rule,
  d: Deficit | undefined,
  state: PolicyState,
): boolean {
  if (rule.status === "NONE") {
    if (state.deficits.some((x) => x.status !== "RESOLVED")) return false;
  } else if (!d || (rule.status !== "ANY" && d.status !== rule.status))
    return false;
  const owner = state.agents.find((a) => a.id === (d?.owner ?? "root"));
  return rule.guards.every((g) =>
    g === "stalled"
      ? owner?.stalled
      : g === "has_artifact"
        ? (d?.artifactIds.length ?? 0) > 0
        : g === "depth_room"
          ? (owner?.depth ?? 0) < state.maxDepth
          : state.agents.some(
              (a) =>
                a.id !== "root" &&
                a.status === "ACTIVE" &&
                !state.deficits.some(
                  (x) =>
                    x.status !== "RESOLVED" &&
                    (x.owner === a.id || x.source === a.id),
                ),
            ),
  );
}
export function decide(strategy: Strategy, state: PolicyState): Decision {
  for (const rule of strategy.rules) {
    if (rule.status === "NONE" && matches(rule, undefined, state))
      return bind(rule.action, rule.id, undefined, state);
    for (const d of state.deficits)
      if (matches(rule, d, state)) return bind(rule.action, rule.id, d, state);
  }
  return bind(
    strategy.fallback,
    "fallback",
    state.deficits.find((d) => d.status !== "RESOLVED"),
    state,
  );
}
function bind(
  action: Action,
  ruleId: string,
  d: Deficit | undefined,
  state: PolicyState,
): Decision {
  let agentId = d?.owner ?? "root";
  if (action === "REACTIVATE") agentId = d?.source ?? agentId;
  if (action === "CONTINUE" && d?.status === "ACTIVE" && !d.artifactIds.length)
    agentId = d.source ?? agentId;
  if (action === "DORMANT")
    agentId =
      state.agents.find(
        (a) =>
          a.id !== "root" &&
          a.status === "ACTIVE" &&
          !state.deficits.some(
            (x) =>
              x.status !== "RESOLVED" &&
              (x.owner === a.id || x.source === a.id),
          ),
      )?.id ?? "root";
  return { action, ruleId, agentId, ...(d ? { deficitId: d.id } : {}) };
}
export function sameDecision(a: Decision, b: Decision) {
  const { ruleId: _a, ...x } = a,
    { ruleId: _b, ...y } = b;
  return canonical(x) === canonical(y);
}
export interface Mutation {
  id: string;
  family: string;
  description: string;
  strategy: Strategy;
  posteriorKey: string;
}
const directions: Record<string, Action[]> = {
  MISSING: ["CONTINUE", "DERIVE"],
  LATENT: ["REACTIVATE", "DERIVE", "CONTINUE"],
  ACTIVE: ["CONNECT", "DISCONNECT", "CONTINUE"],
  DELIVERED: ["CONTINUE", "DERIVE", "REACTIVATE"],
  RESOLVED: ["DORMANT", "DISCONNECT", "STOP"],
  NONE: ["STOP", "DORMANT"],
  ANY: [...actions],
};
export function mutations(
  parent: Strategy,
  observed: Set<string>,
  filtered: boolean,
): Mutation[] {
  const results: Mutation[] = [],
    seen = new Set<string>([policyHash(parent)]);
  function add(
    family: string,
    description: string,
    rules: Rule[],
    fallback = parent.fallback,
    stratum = "ANY",
  ) {
    if (rules.length > 24) return;
    // Names carry provenance only; renumber to keep added/guarded rules collision-free.
    rules = rules.map((r, i) => ({ ...r, id: `rule-${i}` }));
    const strategy = strategySchema.parse({ id: "candidate", rules, fallback });
    const hash = policyHash(strategy);
    if (seen.has(hash)) return;
    seen.add(hash);
    const posteriorKey = `${family}:${stratum}:${description}`;
    results.push({
      id: digest({ parent: policyHash(parent), hash }).slice(0, 16),
      family,
      description,
      strategy,
      posteriorKey,
    });
  }
  for (const status of [
    "MISSING",
    "LATENT",
    "ACTIVE",
    "DELIVERED",
    "RESOLVED",
    "NONE",
  ] as const) {
    if (filtered && !observed.has(status)) continue;
    for (const action of filtered ? directions[status] : actions) {
      if (
        !parent.rules.some(
          (r) => r.status === status && r.action === action && !r.guards.length,
        )
      ) {
        add(
          "ADD_FALLBACK",
          `${status}->${action}`,
          [
            { id: `r-${status}-${action}`, status, guards: [], action },
            ...parent.rules,
          ],
          parent.fallback,
          status,
        );
      }
    }
  }
  parent.rules.forEach((r, i) => {
    if (filtered && !observed.has(r.status) && r.status !== "ANY") return;
    const replace = (rule: Rule) =>
      parent.rules.map((old, j) => (i === j ? rule : old));
    for (const action of filtered ? directions[r.status] : actions)
      if (action !== r.action)
        add(
          "CHANGE_ACTION",
          `${r.status}:${r.action}->${action}`,
          replace({ ...r, action }),
          parent.fallback,
          r.status,
        );
    for (const guard of [
      "stalled",
      "has_artifact",
      "depth_room",
      "overactive",
    ] as const) {
      const removing = r.guards.includes(guard);
      add(
        guard === "depth_room"
          ? "CHANGE_RECURSION"
          : removing
            ? "REMOVE_GUARD"
            : "ADD_GUARD",
        `${r.status}:${r.action}:${removing ? "remove" : "add"}:${guard}`,
        replace({
          ...r,
          guards: removing
            ? r.guards.filter((g) => g !== guard)
            : [...r.guards, guard],
        }),
        parent.fallback,
        r.status,
      );
    }
    if (i > 0) {
      const rules = [...parent.rules];
      [rules[i], rules[i - 1]] = [rules[i - 1], rules[i]];
      add(
        r.action === "REACTIVATE" ? "CHANGE_REUSE_ORDER" : "CHANGE_PRIORITY",
        `${r.status}:${r.action}:before:${rules[i].status}:${rules[i].action}`,
        rules,
        parent.fallback,
        r.status,
      );
    }
    if (parent.rules.length > 1)
      add(
        "REMOVE_FALLBACK",
        `remove:${r.status}:${r.action}`,
        parent.rules.filter((_, j) => i !== j),
        parent.fallback,
        r.status,
      );
  });
  return results;
}
export function policyHash(strategy: Strategy): string {
  return digest({
    rules: strategy.rules.map(({ id: _id, ...r }) => r),
    fallback: strategy.fallback,
  });
}
