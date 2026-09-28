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
import { programDecision } from "./strategy-program.js";

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
        : g === "not_reviewed"
          ? !owner?.reviewed
        : g === "not_challenged"
          ? !owner?.challenged
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
  if (strategy.program) return programDecision(strategy.program, state);
  for (const rule of strategy.rules) {
    if (rule.status === "NONE" && matches(rule, undefined, state)) {
      const decision = bind(rule.action, rule.id, undefined, state);
      if (applicable(decision, undefined, state)) return decision;
    }
    for (const d of state.deficits)
      if (matches(rule, d, state)) {
        const decision = bind(rule.action, rule.id, d, state);
        if (applicable(decision, d, state)) return decision;
      }
  }
  return bind(
    strategy.fallback,
    "fallback",
    state.deficits.find((d) => d.status !== "RESOLVED"),
    state,
  );
}
function applicable(decision: Decision, d: Deficit | undefined, state: PolicyState): boolean {
  const target = state.agents.find((a) => a.id === decision.agentId);
  if (decision.action === "REVIEW") return target?.status === "ACTIVE" && !target.reviewed;
  if (decision.action === "CHALLENGE") return target?.status === "ACTIVE" && !target.challenged;
  if (decision.action === "DORMANT") return target?.id !== "root" && target?.status === "ACTIVE";
  if (decision.action === "CONNECT") return !!d?.source && d.status !== "RESOLVED" && d.artifactIds.some((id) => !d.deliveredIds.includes(id));
  if (decision.action === "DERIVE") return !!d && d.status !== "RESOLVED";
  if (decision.action === "REACTIVATE") return state.agents.some((a) => a.id === d?.source && a.status === "DORMANT");
  if (decision.action === "DISCONNECT") return !!d?.deliveredIds.length;
  return true;
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
  NONE: ["STOP", "REVIEW", "CHALLENGE", "DORMANT"],
  ANY: actions.filter(action => action !== "RECONFIGURE"),
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
  // A single collaboration operator must contain its delivery and integration path.
  // Otherwise DERIVE alone cannot affect Root's answer and never receives useful feedback.
  const delivery: Rule[] = [
    { id: "route", status: "ACTIVE", guards: ["has_artifact"], action: "CONNECT" },
    { id: "integrate", status: "DELIVERED", guards: [], action: "CONTINUE" },
  ];
  for (const status of ["MISSING", "LATENT"] as const) {
    if (filtered && !observed.has(status)) continue;
    add("ADD_COLLABORATION", `${status}:derive-deliver-integrate`, [
      ...delivery,
      { id: "derive", status, guards: ["depth_room"], action: "DERIVE" },
      ...parent.rules,
    ], parent.fallback, status);
  }
  if (!filtered || observed.has("NONE")) {
    const review: Rule = { id: "review", status: "NONE", guards: ["not_reviewed"], action: "REVIEW" };
    add("ADD_REVIEW", "NONE:independent-review", [review, ...parent.rules], parent.fallback, "NONE");
    add("ADD_COLLABORATION", "NONE:review-then-delegate-open-issues", [
      ...delivery,
      { id: "reuse", status: "LATENT", guards: ["depth_room"], action: "REACTIVATE" },
      { id: "derive", status: "MISSING", guards: ["depth_room"], action: "DERIVE" },
      review, ...parent.rules,
    ], parent.fallback, "NONE");
    add("ADD_COLLABORATION", "NONE:independent-solution-deliver-integrate", [
      ...delivery,
      { id: "independent", status: "NONE", guards: ["not_challenged", "depth_room"], action: "CHALLENGE" },
      ...parent.rules,
    ], parent.fallback, "NONE");
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
      "not_reviewed",
      "not_challenged",
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
    program: strategy.program, prompts: strategy.prompts, organization: strategy.organization,
  });
}
