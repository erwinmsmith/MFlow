import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  ModelProvider,
  SampleInput,
  SampleOutput,
} from "@codesoul-co/ditto/worker/infer";
import { DittoAgents, MeteredProvider } from "../src/ditto.js";
import { OrganizationRuntime } from "../src/runtime.js";
import {
  limitsSchema,
  rootProfile,
  initialStrategy,
  type Strategy,
} from "../src/types.js";
import { ScriptedProvider, output, request } from "./fixtures.js";

const adaptive: Strategy = {
  id: "adaptive",
  rules: [
    { id: "stop", status: "NONE", guards: [], action: "STOP" },
    { id: "reuse", status: "LATENT", guards: [], action: "REACTIVATE" },
    { id: "derive", status: "MISSING", guards: [], action: "DERIVE" },
    {
      id: "route",
      status: "ACTIVE",
      guards: ["has_artifact"],
      action: "CONNECT",
    },
    { id: "absorb", status: "DELIVERED", guards: [], action: "CONTINUE" },
  ],
  fallback: "CONTINUE",
};
const model = {
  model: "scripted-test-only",
  baseUrl: "https://invalid.example",
  temperature: 0,
  seed: 42,
};
test("published Ditto composes derived agent, artifact routing and owner resolution", async () => {
  const fake = new ScriptedProvider(),
    meter = new MeteredProvider(fake),
    adapter = new DittoAgents(meter, model);
  const runtime = new OrganizationRuntime(
    adapter,
    limitsSchema.parse({ maxSteps: 8 }),
  );
  const result = await runtime.run(adaptive, {
    id: "t",
    prompt: "Multiply 7 by 8.",
  });
  assert.equal(result.answer, "56");
  assert.equal(result.agents.length, 2);
  assert.equal(result.peakActive, 2);
  assert.equal(result.depth, 1);
  assert.deepEqual(
    result.trace.map((t) => t.decision.action),
    ["DERIVE", "CONNECT", "CONTINUE", "STOP"],
  );
  assert.equal(result.trace[1].state.deficits[0].status, "ACTIVE");
  assert.equal(result.trace[2].state.deficits[0].status, "DELIVERED");
  assert.equal(result.trace[3].state.deficits[0].status, "RESOLVED");
  assert.equal(result.edges.length, 1);
  assert.ok(result.tokens > 0);
  for (const input of fake.inputs) {
    const { payload } = request(input);
    assert.ok(!("answer" in (payload.task ?? {})));
  }
});
test("reactivating an existing profile avoids factory, standard tasks reset all episodes", async () => {
  const fake = new ScriptedProvider(),
    meter = new MeteredProvider(fake),
    adapter = new DittoAgents(meter, model);
  const pool = [
    rootProfile,
    {
      ...rootProfile,
      id: "old",
      capability: "Multiplication",
      private_context: "Persistent capability instructions",
    },
  ];
  const runtime = new OrganizationRuntime(
    adapter,
    limitsSchema.parse({ maxSteps: 8 }),
    pool,
  );
  const a = await runtime.run(adaptive, { id: "a", prompt: "Multiply." });
  const b = await runtime.run(adaptive, { id: "b", prompt: "Multiply again." });
  assert.equal(a.trace[0].decision.action, "REACTIVATE");
  assert.equal(b.trace[0].decision.action, "REACTIVATE");
  assert.ok(!fake.inputs.some((i) => request(i).kind === "factory"));
  assert.equal(a.agents.length, b.agents.length);
  assert.equal(pool.length, 2);
  assert.equal(
    fake.inputs.filter(
      (i) =>
        request(i).kind === "agent" &&
        request(i).payload.profile.id === "root" &&
        request(i).payload.episode.length === 0,
    ).length,
    2,
  );
});
test("baseline never derives; depth and active budgets are enforced", async () => {
  const adapter = new DittoAgents(
    new MeteredProvider(new ScriptedProvider()),
    model,
  );
  const runtime = new OrganizationRuntime(
    adapter,
    limitsSchema.parse({ maxSteps: 2, maxDepth: 0, maxActiveAgents: 1 }),
  );
  const baseline = await runtime.run(initialStrategy, {
    id: "a",
    prompt: "Multiply",
  });
  assert.equal(baseline.agents.length, 1);
  const denied = await runtime.run(adaptive, { id: "b", prompt: "Multiply" });
  assert.equal(denied.agents.length, 1);
  assert.ok(denied.trace.every((t) => t.event.includes("resource-limit")));
});
test("missing usage fails closed", async () => {
  const inner: ModelProvider = {
    async invoke() {
      return {
        message: { role: "assistant", content: "{}" },
        finishReason: "stop",
      };
    },
  };
  await assert.rejects(
    () =>
      new MeteredProvider(inner).invoke(
        { messages: [], model: { model: "x" } },
        { signal: new AbortController().signal },
      ),
    /token usage/,
  );
});
test("Ditto ReAct actually calls registered arithmetic tool", async () => {
  let invoked = 0;
  const provider: ModelProvider = {
    async invoke(input: SampleInput): Promise<SampleOutput> {
      invoked++;
      if (invoked === 1)
        return {
          message: { role: "assistant", content: "" },
          finishReason: "action_request",
          actionRequests: [
            {
              id: "a1",
              name: "arithmetic",
              arguments: { operation: "multiply", values: [7, 8] },
            },
          ],
          usage: { totalTokens: 10 },
        };
      assert.ok(JSON.stringify(input.messages).includes("56"));
      return {
        message: { role: "assistant", content: JSON.stringify(output("56")) },
        finishReason: "stop",
        usage: { totalTokens: 10 },
      };
    },
  };
  const runtime = new OrganizationRuntime(
    new DittoAgents(new MeteredProvider(provider), model),
    limitsSchema.parse({}),
    [{ ...rootProfile, reasoning: "react", tools: ["arithmetic"] }],
  );
  const result = await runtime.run(initialStrategy, {
    id: "t",
    prompt: "Multiply",
  });
  assert.equal(result.answer, "56");
  assert.ok(result.toolEvents.length > 0);
  assert.equal(invoked, 2);
});
