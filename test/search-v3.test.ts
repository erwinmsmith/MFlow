import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Search, type SearchNode } from "../src/search.js";
import { searchExperience, stableTopScores } from "../src/search-feedback.js";
import { DittoAgents, MeteredProvider } from "../src/ditto.js";
import { OrganizationRuntime } from "../src/runtime.js";
import { evaluateFrozen } from "../src/evaluation.js";
import { rootProfile, searchConfigSchema, type Task } from "../src/types.js";
import { ScriptedProvider, output, request } from "./fixtures.js";

const model = { model: "fixture", baseUrl: "https://invalid.example", temperature: 0, seed: 42 };
const task: Task = { id: "fixture", prompt: "Multiply seven by eight", answer: "56", metric: "numeric" };

test("successive proposals extend a measured child and retain ancestry and parent-specific failures", async () => {
  let proposals = 0;
  const provider = new ScriptedProvider((input) => {
    const { kind, payload } = request(input);
    if (kind === "mutation-proposal") {
      proposals++;
      assert.equal(payload.parent.id, proposals === 1 ? "s0" : "s1");
      assert.deepEqual(payload.experience.lineage.map((n: { id: string }) => n.id), proposals === 1 ? ["s0"] : ["s0", "s1"]);
      assert.ok(!JSON.stringify(payload).includes('"answer":"56"'));
      const description = proposals === 1 ? "NONE:independent-review" : "NONE:independent-solution-deliver-integrate";
      const edit = payload.legal_edits.find((e: { description: string }) => e.description === description);
      return { ids: [edit.id], rationale: "Fixture structural change" };
    }
    if (kind === "factory") return { ...rootProfile, id: payload.id };
    if (kind === "review") return output("56");
    if (payload.profile.id !== "root") return { ...output("56"), artifacts: [{ id: "proof", type: "calculation", content: "7*8=56", deficit_refs: [payload.assigned.id] }] };
    return output(payload.incoming.length ? "56" : "0", [], payload.owned_deficits.map((d: { id: string }) => d.id));
  });
  const config = searchConfigSchema.parse({ proposalMode: "aflow", maxIterations: 2, topParents: 1, maxExecutions: 20 });
  const search = new Search(new OrganizationRuntime(new DittoAgents(new MeteredProvider(provider), model), config.episode), config, await mkdtemp(join(tmpdir(), "mflow-lineage-")));
  await search.run([task]);
  assert.equal(proposals, 2);
  assert.equal(search.nodes[2].parent, "s1");
  const failed: SearchNode = { ...search.nodes[2], id: "rejected-sibling", parent: "s1", status: "rejected", utility: undefined, reason: "progressive harms" };
  const unrelated = Array.from({ length: 12 }, (_, i) => ({ ...failed, id: `other-${i}`, parent: "s0" }));
  const memory = searchExperience(search.nodes[1], [...search.nodes, failed, ...unrelated]);
  assert.deepEqual(memory.lineage.map((n) => n.id), ["s0", "s1"]);
  assert.equal(memory.parentTrials.at(-1)?.id, failed.id);
  assert.equal(memory.parentTrials.at(-1)?.accuracy, undefined);
  assert.equal(memory.parentTrials.at(-1)?.complete, false);
  const decisions = (await readFile(join(search.out, "decisions.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(decisions[1].parentCandidates[0].probability, 1);
});

test("convergence needs a full stability window and resets after a measured improvement", () => {
  assert.equal(stableTopScores([0.7, 0.7, 0.7], 3), false);
  assert.equal(stableTopScores([0.7, 0.7, 0.7, 0.71], 3), false);
  assert.equal(stableTopScores([0.7, 0.71, 0.71, 0.71, 0.71], 3), true);
});

test("an equally accurate cheaper child can replace a resource-infeasible root", async () => {
  const provider = new ScriptedProvider((input) => {
    const { kind, payload } = request(input);
    if (kind === "mutation-proposal") {
      const edit = payload.legal_edits.find((e: { description: string }) => e.description === "MISSING->STOP");
      assert.ok(edit);
      return { ids: [edit.id], rationale: "Stop redundant fixture turns" };
    }
    return output("56", [{ id: "fixture", text: "Fixture unresolved check" }]);
  });
  const config = searchConfigSchema.parse({ variant: "mia-acq", proposalMode: "aflow", maxIterations: 1, meanTokenLimit: 40, episode: { maxSteps: 3 } });
  const search = new Search(new OrganizationRuntime(new DittoAgents(new MeteredProvider(provider), model), config.episode), config, await mkdtemp(join(tmpdir(), "mflow-cheaper-")));
  const best = await search.run([task]);
  assert.equal(search.nodes[0].feasible, false);
  assert.equal(search.nodes[1].feasible, true);
  assert.equal(search.nodes[1].utility, search.nodes[0].utility);
  assert.equal(best.strategy.id, "s1");
});

test("failed evaluation resumes only unfinished tasks and retains failed-call cost and frozen manifest", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "mflow-resume-")), "test");
  const tasks = [task, { ...task, id: "second", prompt: "Seven times eight" }];
  const config = searchConfigSchema.parse({});
  const manifest = { bundle: "frozen", dataset: "two-fixtures", version: 4 };
  const build = () => {
    const provider = new MeteredProvider(new ScriptedProvider(() => output("56")));
    return { provider, runtime: new OrganizationRuntime(new DittoAgents(provider, model), config.episode) };
  };
  const first = build();
  await assert.rejects(() => evaluateFrozen({ out: dir, resume: false, manifest, tasks, provider: first.provider,
    evaluate: async (t) => {
      const execution = await first.runtime.run({ id: "s0", rules: [{ id: "stop", status: "NONE", guards: [], action: "STOP" }], fallback: "STOP" }, t);
      if (t.id === "second") throw new Error("simulated interruption after a paid call");
      return { taskId: t.id, score: 1, execution };
    },
  }), /simulated interruption/);
  assert.equal(JSON.parse(await readFile(join(dir, "status.json"), "utf8")).completed, 1);
  const second = build();
  const resumed = await evaluateFrozen({ out: dir, resume: true, manifest, tasks, provider: second.provider,
    evaluate: async (t) => {
      assert.equal(t.id, "second");
      return { taskId: t.id, score: 1, execution: await second.runtime.run({ id: "s0", rules: [{ id: "stop", status: "NONE", guards: [], action: "STOP" }], fallback: "STOP" }, t) };
    },
  });
  assert.equal(resumed.rows.length, 2);
  assert.equal(resumed.actualTokens, first.provider.tokens + second.provider.tokens);
  assert.equal(resumed.usage.length, 3);
  await assert.rejects(() => evaluateFrozen({ out: dir, resume: true, manifest: { ...manifest, version: 5 }, tasks, provider: build().provider,
    evaluate: async () => { throw new Error("must never execute"); },
  }), /manifest mismatch/);
});
