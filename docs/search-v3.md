# Search v3: a policy tree with resumable evaluation

Historical protocol. See [v4](search-v4.md) for the later switch to the upstream AFlow controller.

## Parent selection and feedback

Pinned reference: AFlow `3f457218fc716093fe53f6df8a5d5e6379d66346`, especially `Optimizer._optimize_graph`, `DataUtils.select_round`, `ExperienceUtils`, and `ConvergenceUtils`. AFlow can extend an earlier high-scoring node; chronological rounds are not necessarily a single parent-child chain. Its 20 optimization iterations can produce rounds 1 through 21 because initialization is evaluated separately.

MFlow v2 already had branches (`s0 -> s1 -> s2 -> s4`, and `s0 -> s3`) but allowed only four candidates and exposed limited edit history. V3 changed the following:

- Initial policy plus at most 20 candidates; 2,600 task executions cover 21 x 119. No extra total search token cap. Historical episode limits remained 24k tokens, 4096 output tokens, and 12 steps.
- Select from at most four expandable high-performing parents using 0.3 uniform exploration plus 0.7 temperature-0.05 softmax. Accuracy ties prefer lower logical token cost.
- Supply the full ancestor chain, all tested children of that parent, and recent evidence from other branches: corrections, harms, completeness, feasibility, cost, stop reason, and unintegrated derivations.
- Rotate validation failure samples deterministically. Never report a partial candidate as having complete accuracy.
- Deduplicate full strategy hashes. The LLM proposes legal grammar IDs; MIA uses observed paired results. Executors receive no labels, references, or search history.
- Promote only complete feasible candidates. Equal accuracy with lower logical cost can promote. Partial evaluation only permits rejection.
- Stop after at least eight candidate experiments, at least three complete feasible strategies, and five successive complete feasible candidates with an unchanged top-three accuracy mean. Failed/rejected candidates do not advance this window. This is a heuristic, not a significance test.

Artifacts: `tree.json`, `experience.json`, `proposals.jsonl`, `decisions.jsonl`, `curve.jsonl`, and `summary.json` retain the tree, parent sampling, paired outcomes, costs, selected ancestry, and stop reason.

## Observed failures and repairs

1. Removed an implicit 30-second HTTP timeout through the public Ditto `timeoutMs`; the historical per-call 90-second deadline controlled cancellation.
2. Added `stopDetail` to distinguish provider truncation, episode token exhaustion, and reasoning limits. Candidate s4 had 16/119 token stops in validation.
3. Standard evaluation now writes task attempts, errors, status, and usage. `--resume` checks bundle, full dataset, grading code, and Python/Node dependencies before skipping completed tasks. Unknown usage is separate from measured consumption.
4. V2 stopped at 400/486 test tasks without the original exception. Its frozen runtime, bundle, and grader were preserved to finish the remaining tasks; no speculative root cause or mixed-version scores.
5. AutoAgents parsing, role names, and AFlow commented prompts were repaired at the adapter boundary; see [baseline rerun](baseline-rerun.md).
6. Some provider calls repeated reasoning until an approximately 393k output-token hard limit. DyLAN/EvoAgent record `provider_output_limit` as a terminal task failure, retain cost, and continue the test. Resume does not repurchase that terminal failure. AFlow retains its native retry policy.
7. Non-streaming calls obscured whether work was generating, queued, or stalled. Process existence alone was insufficient evidence. The general package requirement is recorded in [Ditto requirements](ditto-requirements.md).

MATH remained 119/486 with full validation from a new root. V3 changed both search duration and control, so an accuracy difference from v2 is not attributable to one edit without ablation. Test feedback is excluded from search.

Historical offline checks: 44 passed, one Docker-dependent test skipped, and seven baseline adapter checks passed. These verify implementation contracts, not model quality. Use the frozen historical revision for reproduction; current default `search` has different semantics.
