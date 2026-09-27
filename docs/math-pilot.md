# MATH pilot

This pilot uses the pinned AFlow MATH validate/test splits (119/486), DeepSeek Flash,
seed 42, `mia-full`, and standard per-task isolation. Search is limited to 20
iterations, 1000 task executions and 21,000,000 actual search tokens. The held-out
test is evaluated only after the strategy is frozen.

The first real attempt (`runs/math-flash-20260927-01`) stopped on the fourth
validation question because its structured response exceeded the 1200 output-token
limit. Three earlier completed responses also contained final answers inconsistent
with their own supporting calculations. This failed attempt is retained separately.
Before starting a fresh attempt, the generic agent prompt and JSON schema were
changed to place the final answer after the supporting claims and request a
consistency check. The MATH pilot output allowance is 4096 tokens per model call;
the user subsequently allowed about 30M tokens for all attempts combined. The fresh pilot reserves 21M for search and up to 7.776M (486 × 16000) for held-out episodes, leaving room for the failed diagnostics. Other episode budgets are unchanged. The explicit-state resource version
was bumped so older cached/checkpointed turns cannot be reused across this change.

A scorer regression was also fixed: bare LaTeX expressions such as `\sqrt{2}+1`
are wrapped in math delimiters before extraction. Both correct and incorrect
symbolic expressions are covered by regression tests. These repairs were based
on validation outputs and synthetic examples; held-out answers were not used to
select prompts, settings or strategies.

```sh
npm run build
npm run mflow -- search --search data/benchmarks/math/search.jsonl \
  --config configs/math-pilot.json --out runs/math-search
npm run mflow -- evaluate --bundle runs/math-search/best.json \
  --test data/benchmarks/math/test.jsonl --out runs/math-test
```

The run directories contain the exact configuration, implementation commit,
per-task trajectories, costs and failure records. A single-seed pilot establishes
execution behavior; it does not establish a reliable improvement over a baseline.

A second attempt and a single-question diagnostic confirmed repetitive model output
on one validation question, even with an 8192-token diagnostic allowance. A
provider-reported length limit is now handled as episode token exhaustion: retain
any earlier valid answer, or return an empty unsuccessful answer when there is none,
record `stopReason=tokens`, and continue the experiment. Incomplete JSON is never
parsed or used as evidence. Network errors and malformed *completed* outputs remain
infrastructure failures. This behavior is covered by a runtime regression test.
