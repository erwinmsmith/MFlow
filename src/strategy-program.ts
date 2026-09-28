import { Script } from "node:vm";
import { z } from "zod";
import { actions, type PolicyState, type Decision } from "./types.js";

const decisionSchema = z.object({
  action: z.enum(actions), agentId: z.string().optional(),
  deficitId: z.string().optional(), request: z.string().min(1).optional(),
  ruleId: z.string().default("program"),
}).strict();

export function validateProgram(body: string) {
  new Script(`(function(state) { "use strict";\n${body}\n})`);
}

/** Application-owned pure organization policy, with no model or tool access.
 * A VM is a control-flow guard, not an OS security boundary for hostile code. */
export function programDecision(body: string, state: PolicyState): Decision {
  const script = new Script(`JSON.stringify((function(state) { "use strict";\n${body}\n})(${JSON.stringify(state)}))`);
  const result = script.runInNewContext(Object.create(null), {
    timeout: 100, contextCodeGeneration: { strings: false, wasm: false },
    microtaskMode: "afterEvaluate",
  });
  const decision = decisionSchema.parse(JSON.parse(result));
  if (decision.agentId && !state.agents.some((a) => a.id === decision.agentId))
    throw new Error("Policy selected an unknown agent");
  if (decision.deficitId && !state.deficits.some((d) => d.id === decision.deficitId))
    throw new Error("Policy selected an unknown deficit");
  if (decision.request && (decision.action !== "DERIVE" || decision.deficitId))
    throw new Error("A new request requires DERIVE without an existing deficitId");
  return decision;
}
