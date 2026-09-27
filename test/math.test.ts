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
  assert.equal(result.answer, "");
  assert.equal(result.actualTokens, 20);
});
