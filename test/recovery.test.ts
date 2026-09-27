import assert from "node:assert/strict";
import test from "node:test";
import { DittoAgents, MeteredProvider, BudgetExhausted } from "../src/ditto.js";
import { OrganizationRuntime } from "../src/runtime.js";
import { CanonicalPool } from "../src/canonical.js";
import {
  initialStrategy,
  limitsSchema,
  rootProfile,
  type Strategy,
} from "../src/types.js";
import { ScriptedProvider, output, request } from "./fixtures.js";

const model = {
  model: "fixture",
  baseUrl: "https://invalid.example",
  temperature: 0,
  seed: 42,
};
const limits = limitsSchema.parse({ maxSteps: 4 });
const task = { id: "t", prompt: "Multiply seven and eight." };
const adaptive: Strategy = {
  id: "child",
  rules: [
    { id: "derive", status: "MISSING", guards: [], action: "DERIVE" },
    { id: "reuse", status: "LATENT", guards: [], action: "REACTIVATE" },
    {
      id: "route",
      status: "ACTIVE",
      guards: ["has_artifact"],
      action: "CONNECT",
    },
    { id: "absorb", status: "DELIVERED", guards: [], action: "CONTINUE" },
    { id: "stop", status: "NONE", guards: [], action: "STOP" },
  ],
  fallback: "CONTINUE",
};
const make = (provider = new ScriptedProvider()) =>
  new DittoAgents(new MeteredProvider(provider), model);

test("prefix recovery matches full child execution, charges only suffix and survives JSON transport", async () => {
  const agents = make(),
    runtime = new OrganizationRuntime(agents, limits);
  runtime.captureCheckpoints = true;
  const parent = await runtime.run(initialStrategy, task);
  const saved = JSON.parse(JSON.stringify(parent.checkpoints[0]));
  const restored = await runtime.run(adaptive, task, {
    checkpoint: saved,
    prefix: [],
  });
  const full = await new OrganizationRuntime(make(), limits).run(
    adaptive,
    task,
  );
  assert.equal(restored.answer, full.answer);
  assert.deepEqual(restored.outputs, full.outputs);
  assert.deepEqual(restored.trace, full.trace);
  assert.equal(restored.tokens, full.tokens);
  assert.equal(restored.calls, full.calls);
  assert.equal(restored.actualTokens, full.actualTokens - saved.state.tokens);
  assert.equal(restored.actualCalls, full.actualCalls - saved.state.calls);
  assert.deepEqual(saved, parent.checkpoints[0]);
  const other = await runtime.run(
    {
      ...adaptive,
      id: "other",
      rules: [{ id: "stop", status: "ANY", guards: [], action: "STOP" }],
    },
    task,
    { checkpoint: saved, prefix: [] },
  );
  assert.equal(other.agents.length, 1);
  assert.equal(other.actualTokens, 0);
  await assert.rejects(
    runtime.run(
      adaptive,
      { ...task, prompt: "Different" },
      { checkpoint: saved, prefix: [] },
    ),
    /mismatch/,
  );
  saved.state.population[0].episode.push("corruption");
  await assert.rejects(
    runtime.run(adaptive, task, { checkpoint: saved, prefix: [] }),
    /mismatch/,
  );
});

test("later divergence preserves earlier checkpoints and rejects incompatible preceding decisions", async () => {
  const runtime = new OrganizationRuntime(make(), limits);
  runtime.captureCheckpoints = true;
  const parent = await runtime.run(adaptive, task);
  const child = {
    ...adaptive,
    id: "later",
    rules: adaptive.rules.map((r) =>
      r.id === "route" ? { ...r, action: "STOP" as const } : r,
    ),
  };
  const recovered = await runtime.run(child, task, {
    checkpoint: parent.checkpoints[1],
    prefix: parent.checkpoints.slice(0, 1),
  });
  assert.equal(recovered.reusedPrefixSteps, 1);
  assert.equal(recovered.actualCalls, 0);
  assert.equal(recovered.checkpoints.length, 2);
  assert.deepEqual(recovered.trace[0], parent.trace[0]);
  await assert.rejects(
    runtime.run(initialStrategy, task, {
      checkpoint: parent.checkpoints[1],
      prefix: parent.checkpoints.slice(0, 1),
    }),
    /preceding/,
  );
});

test("agent cache preserves logical cost and invalidates on task or configuration changes", async () => {
  const agents = make();
  agents.cacheEnabled = true;
  const runtime = new OrganizationRuntime(agents, limits);
  const first = await runtime.run(adaptive, task),
    second = await runtime.run(adaptive, task);
  assert.equal(second.answer, first.answer);
  assert.equal(second.tokens, first.tokens);
  assert.ok(second.actualTokens < first.actualTokens);
  const different = await runtime.run(adaptive, {
    ...task,
    prompt: "Different multiplication",
  });
  assert.equal(different.actualTokens, first.actualTokens);
  const changed = new OrganizationRuntime(agents, limits, [
    { ...rootProfile, private_context: "new resource state" },
  ]);
  assert.ok(
    (await changed.run(adaptive, task)).actualTokens > second.actualTokens,
  );
});

test("unisolated tools cannot participate in checkpoints or cache", async () => {
  const agents = make();
  agents.tools.push({
    name: "external",
    description: "External",
    effects: ["read"],
    inputSchema: { type: "object" },
    validate() {},
    async execute() {
      return { status: "success", content: "ok" };
    },
  });
  const runtime = new OrganizationRuntime(agents, limits);
  runtime.captureCheckpoints = true;
  await assert.rejects(
    runtime.run(adaptive, task),
    /isolated versioned resources/,
  );
  assert.equal(agents.provider.calls, 0);
});

test("shared Ditto budget rejects competing admission; failed usage stays charged with provenance", async () => {
  const input = { messages: [], model: { model: "fixture" } };
  const delayed = new MeteredProvider(
    {
      async invoke() {
        await new Promise((r) => setTimeout(r, 5));
        return {
          message: { role: "assistant", content: "ok" },
          finishReason: "stop",
          usage: { totalTokens: 10 },
        };
      },
    },
    () => 100,
  );
  delayed.tokenLimit = 100;
  const calls = await Promise.allSettled([
    delayed.invoke(input, { signal: new AbortController().signal }),
    delayed.invoke(input, { signal: new AbortController().signal }),
  ]);
  assert.equal(calls.filter((c) => c.status === "fulfilled").length, 1);
  assert.ok(
    calls.some(
      (c) => c.status === "rejected" && c.reason instanceof BudgetExhausted,
    ),
  );
  const failed = new MeteredProvider(
    {
      async invoke() {
        throw new Error("network");
      },
    },
    () => 100,
  );
  failed.beginEpisode(100, { runId: "t", branchId: "s1" });
  await assert.rejects(
    failed.invoke(input, { signal: new AbortController().signal }),
    /network/,
  );
  assert.equal(failed.tokens, 100);
  assert.equal(failed.records[0].status, "unknown");
  assert.equal(failed.records[0].scope.branchId, "s1");
});

test("continual pool persists compact memory and profiles; invalid consolidation is discarded", async () => {
  const agents = make(
    new ScriptedProvider((input) => {
      const { kind, payload } = request(input);
      if (kind === "consolidate")
        return {
          retain: payload.profiles.map((p: { id: string }) => p.id),
          memories: [{ agentId: "root", text: "Decompose multiplication." }],
        };
      return output("56");
    }),
  );
  const runtime = new OrganizationRuntime(agents, limits);
  const execution = await runtime.run(initialStrategy, task);
  const pool = new CanonicalPool([rootProfile], "bundle-v1");
  const original = pool.snapshot();
  await pool.commit(
    { ...execution, agents: [rootProfile, { ...rootProfile, id: "worker" }] },
    task,
    agents,
    limits,
  );
  const restored = new CanonicalPool(
    [rootProfile],
    "bundle-v1",
    JSON.parse(JSON.stringify(pool.snapshot())),
  );
  assert.equal(restored.profiles().length, 2);
  assert.match(restored.profiles()[0].private_context, /Decompose/);
  assert.throws(() => restored.assertUnseen(task), /already present/);
  assert.throws(
    () => new CanonicalPool([rootProfile], "different", pool.snapshot()),
    /incompatible/,
  );
  assert.equal(
    new CanonicalPool([rootProfile], "bundle-v1", original).profiles().length,
    1,
  );
  const before = restored.snapshot();
  const bad = make(
    new ScriptedProvider(() => ({ retain: ["invented"], memories: [] })),
  );
  await assert.rejects(
    restored.commit(
      execution,
      { id: "next", prompt: "Next task" },
      bad,
      limits,
    ),
    /Invalid canonical/,
  );
  assert.deepEqual(restored.snapshot(), before);
});
