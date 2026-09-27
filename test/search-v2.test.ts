import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mutations, decide, sameDecision } from "../src/policy.js";
import { DittoAgents, MeteredProvider } from "../src/ditto.js";
import { OrganizationRuntime } from "../src/runtime.js";
import { Search } from "../src/search.js";
import { initialStrategy, rootProfile, limitsSchema, searchConfigSchema, type PolicyState } from "../src/types.js";
import { ScriptedProvider, output, request } from "./fixtures.js";

const model = { model: "fixture", baseUrl: "https://invalid.example", temperature: 0, seed: 42 };

test("inapplicable dormant actions do not mask the next stop rule", () => {
  const state: PolicyState = { deficits: [], agents: [{ id: "root", status: "ACTIVE", depth: 0, turns: 1, stalled: false }], maxDepth: 3 };
  const candidate = { ...initialStrategy, rules: [{ id: "idle", status: "NONE" as const, guards: [], action: "DORMANT" as const }, ...initialStrategy.rules] };
  assert.ok(sameDecision(decide(candidate, state), decide(initialStrategy, state)));
});

test("review can reveal an overlooked gap and complete a derived-agent collaboration", async () => {
  const fake = new ScriptedProvider((input) => {
    const { kind, payload } = request(input);
    if (kind === "factory") {
      assert.equal(payload.parent_evidence.candidate_answer, "0");
      return { ...rootProfile, id: payload.id };
    }
    if (kind === "review") return output("0", [{ id: "check", text: "The product needs an independent calculation." }]);
    if (payload.profile.id !== "root") return { ...output("56"), artifacts: [{ id: "calculation", type: "number", content: "7*8=56", deficit_refs: [payload.assigned.id] }] };
    return payload.incoming.length ? output("56", [], ["root:check"]) : output("0");
  });
  const runtime = new OrganizationRuntime(new DittoAgents(new MeteredProvider(fake), model), limitsSchema.parse({ maxSteps: 8 }));
  const operator = mutations(initialStrategy, new Set(["NONE"]), true).find((m) => m.description === "NONE:review-then-delegate-open-issues")!;
  const result = await runtime.run(operator.strategy, { id: "fixture", prompt: "Multiply seven by eight." });
  assert.equal(result.answer, "56");
  assert.equal(result.agents.length, 2);
  assert.deepEqual(result.trace.map((t) => t.decision.action), ["REVIEW", "DERIVE", "CONNECT", "CONTINUE", "STOP"]);
  assert.equal(fake.inputs.filter((i) => request(i).kind === "review").length, 1);
  for (const input of fake.inputs) {
    const payloadMessages = input.messages.filter((m) => typeof m.content === "string" && m.content.includes('"payload":'));
    assert.equal(payloadMessages.length, 1, "Context must not duplicate the original payload");
    assert.ok(!("answer" in (request(input).payload.task ?? {})));
  }
});

test("AFlow-style proposals use validation feedback and execute only legal complete edits", async () => {
  const inner = new ScriptedProvider();
  let proposed = false;
  const provider = { async invoke(input: Parameters<ScriptedProvider["invoke"]>[0]) {
    const { kind, payload } = request(input);
    if (kind !== "mutation-proposal") return inner.invoke(input);
    proposed = true;
    assert.equal(payload.failure_examples[0].score, 0);
    assert.equal(payload.failure_examples[0].prediction, "0");
    assert.ok(!JSON.stringify(payload).includes("hidden-reference"));
    const edit = payload.legal_edits.find((e: { description: string }) => e.description === "MISSING:derive-deliver-integrate");
    assert.ok(edit);
    return { message: { role: "assistant" as const, content: JSON.stringify({ ids: [edit.id], rationale: "Deliver the missing arithmetic evidence to Root." }) }, finishReason: "stop" as const, usage: { totalTokens: 20 } };
  } };
  const config = searchConfigSchema.parse({ proposalMode: "aflow", maxIterations: 1, maxExecutions: 20, episode: { maxSteps: 6 } });
  const search = new Search(new OrganizationRuntime(new DittoAgents(new MeteredProvider(provider), model), config.episode), config, await mkdtemp(join(tmpdir(), "mflow-proposal-")));
  const bundle = await search.run([{ id: "fixture", prompt: "Compute 7*8", answer: "56", metric: "numeric" }]);
  assert.ok(proposed);
  assert.notEqual(bundle.strategy.id, "s0");
  assert.equal(search.nodes[1].utility, 1);
  assert.equal(search.nodes[1].results[0].execution.agents.length, 2);
});

test("a searchable independent challenge can spawn even when Root reports no gap", async () => {
  const fake = new ScriptedProvider((input) => {
    const { kind, payload } = request(input);
    if (kind === "factory") {
      assert.equal(payload.parent_evidence, undefined, "Independent solution must not be anchored to the parent answer");
      return { ...rootProfile, id: payload.id };
    }
    if (payload.profile.id !== "root") return { ...output("56"), artifacts: [{ id: "independent", type: "calculation", content: "7*8=56", deficit_refs: [payload.assigned.id] }] };
    return payload.incoming.length ? output("56", [], payload.owned_deficits.map((d: { id: string }) => d.id)) : output("0");
  });
  const runtime = new OrganizationRuntime(new DittoAgents(new MeteredProvider(fake), model), limitsSchema.parse({ maxSteps: 8 }));
  const baseline = await runtime.run(initialStrategy, { id: "b", prompt: "Multiply seven by eight." });
  assert.equal(baseline.agents.length, 1);
  const candidate = mutations(initialStrategy, new Set(["NONE"]), true).find((m) => m.description === "NONE:independent-solution-deliver-integrate")!;
  const result = await runtime.run(candidate.strategy, { id: "c", prompt: "Multiply seven by eight." });
  assert.equal(result.answer, "56");
  assert.equal(result.agents.length, 2);
  assert.deepEqual(result.trace.map((t) => t.decision.action), ["CHALLENGE", "CONNECT", "CONTINUE", "STOP"]);
});


test("one format repair is metered and preserves schema validation", async () => {
  let calls = 0;
  const provider = new MeteredProvider({ async invoke(input) {
    calls++;
    const { kind, payload } = request(input);
    if (calls === 2) { assert.equal(kind, "agent-format-repair"); assert.ok(payload.output.endsWith(" trailing")); }
    return { message: { role: "assistant" as const, content: JSON.stringify(output("56")) + (calls === 1 ? " trailing" : "") },
      finishReason: "stop" as const, usage: { totalTokens: 20 } };
  } });
  const runtime = new OrganizationRuntime(new DittoAgents(provider, model), limitsSchema.parse({}));
  const result = await runtime.run(initialStrategy, { id: "repair", prompt: "Multiply 7 by 8" });
  assert.equal(result.answer, "56");
  assert.equal(provider.tokens, 40);
  assert.equal(calls, 2);
});
