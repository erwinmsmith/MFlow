import { Script } from "node:vm";
import { z } from "zod";
import { actions, statuses, rootProfile, type PolicyState, type Decision } from "./types.js";

export class PolicyContractError extends Error {}

export function normalizeProgram(source: string): string {
  const code = source.trim().replace(/^```(?:javascript|js)?\s*\n([\s\S]*?)\n```$/, '$1').trim();
  // A complete function and its body are two equivalent serializations, not edits
  // to the policy. Never repair its decisions or benchmark answers here.
  if (/^(?:async\s+)?(?:function\b|(?:\([^)]*\)|[\w$]+)\s*=>)/.test(code)) {
    const expression = code.replace(/;\s*$/, '');
    try {
      new Script(`(${expression})`);
      return `return (${expression})(state);`;
    } catch { /* A body can begin with a local helper function declaration. */ }
  }
  return code;
}

const decisionSchema = z.object({
  action: z.enum(actions), agentId: z.string().optional(),
  deficitId: z.string().optional(), request: z.string().min(1).optional(),
  ruleId: z.string().default("program"),
}).strict();

export function validateProgram(body: string) {
  body = normalizeProgram(body);
  new Script(`(function(state) { "use strict";\n${body}\n})`);
  // Interface fixtures contain no benchmark questions/labels. These are contract
  // checks only: no action preference or accuracy threshold is imposed.
  for (const answer of ['', '0', '\\boxed{0}']) {
    for (const status of [undefined, ...statuses]) {
      const state: PolicyState = {
        task: { id: 'contract-fixture', prompt: 'Synthetic interface fixture, not a benchmark problem.' },
        step: status ? 1 : 0, usage: { tokens: 0, calls: 1 }, maxDepth: Number.MAX_SAFE_INTEGER,
        agents: [{ id: 'root', profile: rootProfile, status: 'ACTIVE', depth: 0, turns: 1, stalled: false, reviewed: false, challenged: false },
          ...(status && status !== 'MISSING' ? [{ id: 'agent-1', profile: { ...rootProfile, id: 'agent-1' }, status: status === 'LATENT' ? 'DORMANT' as const : 'ACTIVE' as const, depth: 1, turns: 1, stalled: false, assigned: 'd' }] : [])],
        deficits: status ? [{ id: 'd', text: 'Synthetic missing evidence', owner: 'root', status,
          ...(status !== 'MISSING' ? { source: 'agent-1' } : {}),
          artifactIds: ['ACTIVE', 'DELIVERED', 'RESOLVED'].includes(status) ? ['e'] : [],
          deliveredIds: ['DELIVERED', 'RESOLVED'].includes(status) ? ['e'] : [] }] : [],
        outputs: [{ agentId: 'root', output: { candidate_answer: answer, claims: [], artifacts: [], open_deficits: [], resolved_deficits: [] } }],
        artifacts: status && ['ACTIVE', 'DELIVERED', 'RESOLVED'].includes(status) ? [{ id: 'e', source: 'agent-1', type: 'evidence', content: 'Synthetic evidence', deficitRefs: ['d'] }] : [],
        edges: [], toolEvents: [],
      };
      programDecision(body, state);
    }
  }
}

/** Application-owned pure organization policy, with no model or tool access.
 * A VM is a control-flow guard, not an OS security boundary for hostile code. */
export function programDecision(body: string, state: PolicyState): Decision {
  const script = new Script(`JSON.stringify((function(state) { "use strict";\n${normalizeProgram(body)}\n})(${JSON.stringify(state)}))`);
  try {
  const result = script.runInNewContext(Object.create(null), {
    timeout: 100, contextCodeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  if (result === undefined) throw new Error('Policy returned undefined; return a Decision object on every reachable path');
  const decision = decisionSchema.parse(JSON.parse(result));
  if (decision.agentId && !state.agents.some((a) => a.id === decision.agentId))
    throw new Error("Policy selected an unknown agent");
  if (decision.deficitId && !state.deficits.some((d) => d.id === decision.deficitId))
    throw new Error("Policy selected an unknown deficit");
  if (decision.request && (decision.action !== "DERIVE" || decision.deficitId))
    throw new Error("A new request requires DERIVE without an existing deficitId");
  return decision;
  } catch (error) {
    throw new PolicyContractError(`Policy contract violation: ${String(error)}`);
  }
}
