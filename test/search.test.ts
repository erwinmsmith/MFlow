import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Search, affected } from "../src/search.js";
import { OrganizationRuntime } from "../src/runtime.js";
import { DittoAgents, MeteredProvider } from "../src/ditto.js";
import {
  initialStrategy,
  searchConfigSchema,
  type Task,
} from "../src/types.js";
import { ScriptedProvider, output, request } from "./fixtures.js";
import { rootProfile } from "../src/types.js";

const model = {
  model: "scripted-test-only",
  baseUrl: "https://invalid.example",
  temperature: 0,
  seed: 42,
};
const tasks: Task[] = Array.from({ length: 3 }, (_, i) => ({
  id: `s${i}`,
  prompt: `Fixture ${i}: multiply 7 by 8.`,
  answer: "56",
  metric: "numeric",
}));
test("LLM edit selection budget denial preserves the evaluated incumbent and usage", async () => {
  const config = searchConfigSchema.parse({
    variant: "llm-guided",
    maxIterations: 2,
    maxSearchTokens: 1000,
    episode: { maxSteps: 1 },
  });
  const meter = new MeteredProvider(new ScriptedProvider(), (input) =>
    request(input).kind === "mutation-selection" ? 2000 : 100,
  );
  const search = new Search(
    new OrganizationRuntime(new DittoAgents(meter, model), config.episode),
    config,
    await mkdtemp(join(tmpdir(), "mflow-edit-budget-")),
  );
  const bundle = await search.run(tasks);
  assert.equal(bundle.strategy.id, "s0");
  assert.equal(search.nodes.length, 1);
  assert.equal(search.posterior.observations("unused"), 0);
  assert.equal(
    JSON.parse(await readFile(join(search.out, "summary.json"), "utf8"))
      .stopReason,
    "budget",
  );
  assert.equal(
    JSON.parse(await readFile(join(search.out, "usage.json"), "utf8")).length,
    meter.calls,
  );
});
test("search grows full strategies and promotes only after affected set and holdout execution", async () => {
  const config = searchConfigSchema.parse({
    maxIterations: 12,
    maxExecutions: 80,
    episode: { maxSteps: 4 },
    monteCarloSamples: 100,
  });
  const adapter = new DittoAgents(
    new MeteredProvider(new ScriptedProvider()),
    model,
  );
  const runtime = new OrganizationRuntime(adapter, config.episode),
    dir = await mkdtemp(join(tmpdir(), "mflow-search-"));
  const search = new Search(runtime, config, dir);
  const bundle = await search.run(tasks, [
    { id: "v", prompt: "Holdout: multiply.", answer: "56", metric: "numeric" },
  ]);
  assert.ok(search.nodes.length > 2);
  assert.equal(search.nodes[0].utility, 0);
  const winner = search.nodes.find((n) => n.id === bundle.strategy.id)!;
  assert.equal(winner.utility, 1);
  assert.notEqual(bundle.strategy.id, "s0");
  assert.equal(winner.confirmation?.[0].score, 1);
  assert.ok(search.nodes.every((n) => n.results.length === 3));
  assert.ok(
    search.nodes
      .slice(1)
      .some((n) =>
        n.results.some(
          (r) =>
            !r.inheritedFrom && r.execution.actualTokens! < r.execution.tokens,
        ),
      ),
  );
  assert.equal(bundle.pool.length, 1);
  assert.equal(affected(initialStrategy, search.nodes[0].results).size, 0);
  const curve = (await readFile(join(dir, "curve.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse as (s: string) => any);
  assert.ok(curve[1].tokens > curve[0].tokens);
  assert.ok(curve[1].executions > curve[0].executions);
  assert.ok(Object.values(search.posterior.counts).some((c) => c[0] === 3));
});
test("budget exhaustion during a candidate cannot promote partial evaluation", async () => {
  const config = searchConfigSchema.parse({
    maxIterations: 2,
    maxExecutions: 4,
    episode: { maxSteps: 3 },
    monteCarloSamples: 100,
  });
  const runtime = new OrganizationRuntime(
    new DittoAgents(new MeteredProvider(new ScriptedProvider()), model),
    config.episode,
  );
  const dir = await mkdtemp(join(tmpdir(), "mflow-budget-")),
    search = new Search(runtime, config, dir);
  const bundle = await search.run(tasks);
  assert.equal(bundle.strategy.id, "s0");
  assert.equal(search.nodes[1].status, "budget_exhausted");
  assert.equal(search.nodes[1].results.length, 1);
  const summary = JSON.parse(await readFile(join(dir, "summary.json"), "utf8"));
  assert.equal(summary.executions, 4);
  assert.equal(summary.stopReason, "budget");
});
test("invalid model output aborts instead of becoming a correctness observation", async () => {
  const config = searchConfigSchema.parse({
    maxIterations: 1,
    maxExecutions: 10,
  });
  const runtime = new OrganizationRuntime(
    new DittoAgents(
      new MeteredProvider(new ScriptedProvider(() => ({ bad: true }))),
      model,
    ),
    config.episode,
  );
  const dir = await mkdtemp(join(tmpdir(), "mflow-errors-")),
    search = new Search(runtime, config, dir);
  await assert.rejects(() => search.run(tasks));
  assert.deepEqual(search.posterior.counts, {});
  assert.ok(
    (await readFile(join(dir, "errors.jsonl"), "utf8")).includes("strategyId"),
  );
});
test("resource-infeasible root cannot be exported as an experiment winner", async () => {
  const config = searchConfigSchema.parse({
    maxIterations: 1,
    maxExecutions: 10,
    meanTokenLimit: 1,
    episode: { maxSteps: 1 },
  });
  const runtime = new OrganizationRuntime(
    new DittoAgents(
      new MeteredProvider(new ScriptedProvider(() => output("56"))),
      model,
    ),
    config.episode,
  );
  const search = new Search(
    runtime,
    config,
    await mkdtemp(join(tmpdir(), "mflow-feasible-")),
  );
  await assert.rejects(() => search.run(tasks), /resource constraints/);
});

test("progressive racing rejects a harmful candidate before full affected-set execution", async () => {
  const fake = new ScriptedProvider((input) => {
    const { kind, payload } = request(input);
    if (kind === "factory") return { ...rootProfile, id: payload.id };
    if (kind === "retrieve") return { agent_id: null };
    if (payload.profile.id !== "root")
      return {
        ...output("0"),
        artifacts: [
          {
            id: "bad",
            type: "fixture",
            content: "0",
            deficit_refs: [payload.assigned.id],
          },
        ],
      };
    if (payload.incoming.length) return output("0", [], ["root:d"]);
    return output("56", [{ id: "d", text: "A scripted test deficit" }]);
  });
  const config = searchConfigSchema.parse({
    maxIterations: 12,
    maxExecutions: 150,
    batchSize: 3,
    episode: { maxSteps: 4 },
    monteCarloSamples: 100,
  });
  const runtime = new OrganizationRuntime(
    new DittoAgents(new MeteredProvider(fake), model),
    config.episode,
  );
  const search = new Search(
    runtime,
    config,
    await mkdtemp(join(tmpdir(), "mflow-racing-")),
  );
  const six = Array.from({ length: 6 }, (_, i) => ({
    ...tasks[0],
    id: `t${i}`,
    prompt: `Unique fixture ${i}`,
  }));
  const bundle = await search.run(six);
  assert.equal(bundle.strategy.id, "s0");
  const rejected = search.nodes.find((n) => n.status === "rejected");
  assert.ok(rejected);
  assert.equal(rejected.results.length, 3);
  assert.equal(rejected.utility, undefined);
  assert.ok(Object.values(search.posterior.counts).some((c) => c[2] >= 3));
});
