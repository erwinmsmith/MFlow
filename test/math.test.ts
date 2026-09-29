import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { agentOutputSchema, taskSchema } from "../src/types.js";
import { checkScoring, grade } from "../src/grading.js";

test("agent output places the final answer after supporting claims", () => {
  const schema = z.toJSONSchema(agentOutputSchema);
  assert.equal(Object.keys(schema.properties ?? {}).at(-1), "candidate_answer");
});

test("MATH accepts bare LaTeX expressions without accepting a wrong expression", async (t) => {
  const task = taskSchema.parse({ id: "math:fixture", prompt: "A symbolic result", answer: "The result is \\boxed{\\sqrt{2}+1}.", metric: "math" });
  try { await checkScoring([task]); }
  catch { t.skip("math-verify is not installed in MFLOW_BENCH_PYTHON"); return; }
  for (const answer of ["\\sqrt{2}+1", "$\\sqrt{2}+1$", "\\boxed{\\sqrt{2}+1}"])
    assert.equal((await grade(task, answer)).score, 1, answer);
  for (const answer of ["1", "\\sqrt{3}+1"])
    assert.equal((await grade(task, answer)).score, 0, answer);
});

test("a truncated model response exhausts only its episode, not the experiment", async () => {
  const { DittoAgents, MeteredProvider } = await import("../src/ditto.js");
  const { OrganizationRuntime } = await import("../src/runtime.js");
  const { initialStrategy, limitsSchema } = await import("../src/types.js");
  const provider = new MeteredProvider({ async invoke() {
    return { message: { role: "assistant" as const, content: '{"claims":[' }, finishReason: "length" as const,
      usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 } };
  } });
  const result = await new OrganizationRuntime(new DittoAgents(provider, {
    model: "fixture", baseUrl: "https://invalid.example", temperature: 0, seed: 42,
  }), limitsSchema.parse({})).run(initialStrategy, { id: "truncated", prompt: "q" });
  assert.equal(result.stopReason, "tokens");
  assert.equal(result.stopDetail, "output_limit");
  assert.equal(result.answer, "");
  assert.equal(result.actualTokens, 20);
  const tightProvider = new MeteredProvider({ async invoke() { throw new Error("must not call provider after reservation denial"); } });
  const denied = await new OrganizationRuntime(new DittoAgents(tightProvider, {
    model: "fixture", baseUrl: "https://invalid.example", temperature: 0, seed: 42,
  }), limitsSchema.parse({ maxTokens: 1 })).run(initialStrategy, { id: "denied", prompt: "q" });
  assert.equal(denied.stopDetail, "episode_budget");
  assert.equal(tightProvider.calls, 0);
});


test("MATH plain textual final answers match boxed text without accepting other words", async (t) => {
  const task = taskSchema.parse({ id: "word", prompt: "Name the word", answer: "The word is \\boxed{\\text{MAKE}}.", metric: "math" });
  try { await checkScoring([task]); } catch { t.skip("math-verify unavailable"); return; }
  assert.equal((await grade(task, "MAKE")).score, 1);
  assert.equal((await grade(task, "TAKE")).score, 0);
  assert.equal((await grade(task, "MAKE or TAKE")).score, 0);
});

test('concurrent MATH grading queues local processes and keeps answer equivalence unchanged', async t => {
  const task = taskSchema.parse({ id: 'load-fixture', prompt: 'Synthetic arithmetic', answer: 'The result is \\boxed{2}.', metric: 'math' });
  try { await checkScoring([task]); } catch { t.skip('math-verify unavailable'); return; }
  const scores = await Promise.all(Array.from({ length: 24 }, (_, i) => grade(task, i % 2 ? '3' : '2')));
  assert.deepEqual(scores.map(s => s.score), Array.from({ length: 24 }, (_, i) => i % 2 ? 0 : 1));
});
