import test from "node:test";
import assert from "node:assert/strict";
import { taskSchema } from "../src/types.js";
import { grade, checkScoring } from "../src/grading.js";
import { assertDisjoint } from "../src/data.js";

test("DROP accepts alternate annotations and grades partial multi-span answers", async () => {
  const task = taskSchema.parse({
    id: "drop:1", prompt: "Which names?", answer: "Alice | Bob", metric: "drop",
    reference: { answers: [["Alice", "Bob"], ["Alice Smith", "Robert"]] },
  });
  assert.deepEqual(await grade(task, "Bob | Alice"), { score: 1, f1: 1 });
  assert.deepEqual(await grade(task, "Alice Smith | Robert"), { score: 1, f1: 1 });
  const partial = await grade(task, "Alice");
  assert.equal(partial.score, 0);
  assert.ok(partial.f1! > 0 && partial.f1! < 1);
});

test("benchmark references are required and same prompt cannot cross splits", () => {
  assert.throws(() => taskSchema.parse({ id: "x", prompt: "code", answer: "", metric: "python" }));
  assert.throws(() => taskSchema.parse({ id: "x", prompt: "q", answer: "", metric: "drop" }));
  const a = taskSchema.parse({ id: "a", prompt: "Same question", answer: "a" });
  const b = taskSchema.parse({ id: "b", prompt: "Same   question", answer: "b" });
  assertDisjoint([a, b]); // repeated source annotations may occur inside one official split
  assert.throws(() => assertDisjoint([a], [b]));
});

test("Docker grader executes HumanEval completions and MBPP setup", async (t) => {
  const human = taskSchema.parse({
    id: "human:fixture", prompt: "Complete f", answer: "", metric: "python",
    reference: { prefix: "def f(x):\n    \"\"\"Add one.\"\"\"\n", entryPoint: "f",
      tests: ["def check(candidate):\n    assert candidate(2) == 3"] },
  });
  try { await checkScoring([human]); }
  catch { t.skip("Docker daemon or python:3.12-alpine image unavailable"); return; }
  assert.equal((await grade(human, "    def helper(y):\n        return y + 1\n    return helper(x)\n")).score, 1);
  assert.equal((await grade(human, "    return x\n")).score, 0);
  const mbpp = taskSchema.parse({
    id: "mbpp:fixture", prompt: "Double a number", answer: "", metric: "python",
    reference: { setup: "value = double(3)", tests: ["assert value == 6"] },
  });
  assert.equal((await grade(mbpp, "def double(x):\n    return x * 2")).score, 1);
});
