import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decide, sameDecision, mutations } from "../src/policy.js";
import {
  initialStrategy,
  searchConfigSchema,
  type PolicyState,
  type Strategy,
} from "../src/types.js";
import { prepare, readTasks, assertDisjoint, score } from "../src/data.js";
import { acquisition, Posterior } from "../src/mia.js";
import { Random } from "../src/util.js";

export const adaptive: Strategy = {
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
const state: PolicyState = {
  deficits: [
    {
      id: "d",
      text: "missing",
      owner: "root",
      status: "MISSING",
      artifactIds: [],
      deliveredIds: [],
    },
  ],
  agents: [
    { id: "root", status: "ACTIVE", depth: 0, turns: 1, stalled: false },
  ],
  maxDepth: 3,
};
test("typed policy changes decisions, not semantic agent roles", () => {
  assert.equal(decide(initialStrategy, state).action, "CONTINUE");
  assert.equal(decide(adaptive, state).action, "DERIVE");
  assert.equal(decide(adaptive, { ...state, deficits: [] }).action, "STOP");
  const edits = mutations(initialStrategy, new Set(["MISSING"]), true);
  assert.ok(edits.length);
  assert.ok(
    edits.every((e) => e.strategy.rules.some((r) => r.status === "MISSING")),
  );
  assert.ok(
    !sameDecision(decide(initialStrategy, state), decide(adaptive, state)),
  );
  assert.ok(
    sameDecision(
      { ...decide(adaptive, state), ruleId: "another-name" },
      decide(adaptive, state),
    ),
  );
});
test("resource/policy configuration rejects unsupported modes and executable payloads", () => {
  assert.equal(
    searchConfigSchema.parse({ prefixCache: true, agentCache: true })
      .prefixCache,
    true,
  );
  assert.throws(() => searchConfigSchema.parse({ protocol: "continual" }));
  assert.throws(() => searchConfigSchema.parse({ rewardWeights: [1, 2] }));
});
test("posterior is based only on paired binary outcomes", () => {
  const posterior = new Posterior();
  for (let i = 0; i < 7; i++) posterior.observe("e", 0, 1);
  for (let i = 0; i < 4; i++) posterior.observe("e", 0, 0);
  posterior.observe("e", 1, 0);
  assert.deepEqual(posterior.alpha("e"), [8, 5, 2]);
  const values = acquisition(
    [
      { key: "e", triggerRate: 1 },
      { key: "fresh", triggerRate: 1 },
    ],
    posterior,
    new Random(42),
    5000,
  );
  assert.ok(values.every((v) => v >= 0 && v <= Math.log(2)));
  assert.ok(values.some((v) => v > 0));
  const zeros = acquisition(
    [
      { key: "a", triggerRate: 0 },
      { key: "b", triggerRate: 0 },
    ],
    posterior,
    new Random(42),
    10000,
  );
  assert.ok(zeros.every((v) => v < 0.001));
  assert.deepEqual(
    acquisition([{ key: "a", triggerRate: 1 }], posterior, new Random(1)),
    [0],
  );
});
test("data preparation is deterministic, disjoint and cannot overwrite splits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mflow-data-"));
  const a = await prepare("data/example.jsonl", join(dir, "a"));
  const b = await prepare("data/example.jsonl", join(dir, "b"));
  assert.deepEqual(a, b);
  assertDisjoint(a.search, a.confirmation, a.test);
  assert.equal(a.search.length + a.confirmation.length + a.test.length, 12);
  assert.equal(
    (await readTasks(join(dir, "a/search.jsonl"))).length,
    a.search.length,
  );
  assert.throws(() => assertDisjoint(a.search, a.search));
  assert.throws(() =>
    assertDisjoint(
      [{ id: "a", prompt: "a", answer: "a", metric: "exact", group: "g" }],
      [{ id: "b", prompt: "b", answer: "b", metric: "exact", group: "g" }],
    ),
  );
  await assert.rejects(() => prepare("data/example.jsonl", join(dir, "a")));
  assert.ok(
    JSON.parse(await readFile(join(dir, "a/manifest.json"), "utf8")).sourceHash,
  );
});
test("scoring uses final answer, never last-number heuristics", () => {
  const task = {
    id: "t",
    prompt: "p",
    answer: "56",
    metric: "numeric" as const,
  };
  assert.equal(score(task, "56"), 1);
  assert.equal(score(task, "I guessed 56"), 0);
  assert.equal(score(task, "NaN"), 0);
});
