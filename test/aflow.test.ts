import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { assertDatasetRole, assertTestDisjoint, promptKey, readTasks } from "../src/data.js";
import { grade } from "../src/grading.js";
import { taskSchema } from "../src/types.js";
import { digest } from "../src/util.js";
import overlap from "./fixtures/aflow-drop-overlap.json" with { type: "json" };

const search = taskSchema.parse(overlap.search), heldout = taskSchema.parse(overlap.test);
const selection = {
  selectionTaskIds: [search.id], selectionPromptHashes: [digest(promptKey(search))], selectionGroups: [],
};

test("AFlow roles prohibit held-out search, validation-as-test and resplitting", () => {
  assertDatasetRole([search], "search");
  assertDatasetRole([heldout], "test");
  assert.throws(() => assertDatasetRole([heldout], "search"));
  assert.throws(() => assertDatasetRole([search], "test"));
  assert.throws(() => assertDatasetRole([search], "confirmation"));
  assert.throws(() => assertDatasetRole([search], "prepare"));
});

test("only pinned AFlow DROP ID/prompt pairs may overlap selection", () => {
  assert.equal(assertTestDisjoint([heldout], selection).length, 1);
  assert.throws(() => assertTestDisjoint([{ ...heldout, id: "drop:unknown" }], selection));
  assert.throws(() => assertTestDisjoint([{ ...heldout, aflowSplit: undefined }], selection));
  assert.throws(() => assertTestDisjoint([heldout], { ...selection, selectionTaskIds: ["unknown"] }));
  assert.throws(() => assertTestDisjoint([heldout], { ...selection, selectionTaskIds: [heldout.id] }));
});

test("partial or edited AFlow files cannot silently change benchmark membership", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mflow-aflow-"));
  try {
    const path = join(dir, "partial.jsonl");
    await writeFile(path, JSON.stringify(search) + "\n");
    await assert.rejects(readTasks(path), /complete pinned split/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("AFlow DROP aliases and GSM8K final-number extraction follow source semantics", async () => {
  const task = { ...search, answer: "Alice Alice Bob|Alice Smith" };
  assert.deepEqual(await grade(task, "Alice Smith"), { score: 1, f1: 1 });
  assert.deepEqual(await grade(task, "Alice Bob"), { score: 0, f1: 0.8 });
  assert.deepEqual(await grade(task, "other | Alice Smith"), { score: 1, f1: 1 });
  assert.deepEqual(await grade(taskSchema.parse({ id: "gsm8k:x", prompt: "q", answer: "1200", metric: "numeric",
    benchmark: "gsm8k", aflowSplit: "validate" }), "The calculation is 12 * 100. Answer: 1,200."), { score: 1 });
});

test("AFlow converter keeps source prompts, roles and evaluator-only tests", () => {
  execFileSync("python3", ["-m", "unittest", "discover", "-s", "test", "-p", "benchmark_import_test.py"], { stdio: "pipe" });
});
