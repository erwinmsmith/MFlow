# MBPP search plateau audit and repair — 2026-10-08

## Evidence and interpretation

Audited the completed DeepSeek Flash search at
`../experiments/deepseek-drop-mbpp-mflow-20261008/MFlow/runs/mbpp/MFlow/search`.
Each candidate has 86 search tasks × 5 repetitions. Comparisons below use
per-task mean success across those repetitions, not test performance.

| Round | Actual parent | Search accuracy | Improved tasks vs parent | Regressed tasks vs parent |
| --- | --- | --- | --- | --- |
| 1 | — | 86.05% | — | — |
| 2 | 1 | 0.00% | 0 | 77 |
| 3 | 2 | 83.95% | 74 | 0 |
| 4 | 3 | 85.12% | 5 | 2 |
| 5 | 4 | 84.88% | 3 | 3 |
| 6 | 1 | 82.09% | 3 | 12 |
| 7 | 1 | 82.79% | 1 | 8 |
| 8 | 1 | 84.42% | 5 | 6 |
| 9 | 8 | 83.26% | 4 | 9 |
| 10 | 5 | 81.86% | 4 | 11 |

- R2 returned an AgentOutput where the outer MAS requires a string. All 430
  rows failed that contract. This was not evidence that verification is useless.
- R6/R7/R8 actually inherited R1, but their modification descriptions called
  the parent a diamond/executor/repairer structure from other trials. The parent
  artifact was supplied correctly; the optimizer's interpretation was wrong.
- Several proposals revisited executor/repairer variants. Additional agents
  did not consistently repair the failures and often introduced regressions.
- Search failures include specification/benchmark-convention mismatches as well
  as execution faults. Self-created tests cannot establish an ambiguous expected
  convention. Do not hard-code task-specific exceptions, constants or assertions.
- The MFlow Python grader returned only 0/1. Its search mutation logs lacked the
  failing Python traceback/assertion supplied by the pinned original AFlow MBPP
  evaluator (`benchmarks/mbpp.py`).
- The dynamic seed's next policy decision received published answers, topology,
  programs and decisions, but no direct tool observations. Raw `ctx.graphs` were
  available to executable code; they were not automatically shown to the policy
  model. Published answers are not proof of tool execution.
- An empty `ctx.failedAgent` output counted as a successful stage and reset the
  consecutive broken-stage counter, unlike a thrown execution error.

The old final test stood at 277/340 completed (81.47%) during this audit. The
complete SingleLLM run is 279/341 (81.82%). These aggregates motivate an audit;
test questions, reference tests and candidate mistakes were not used to design
these changes. The outstanding old test request was not interrupted or modified.

## Changes

1. Add opt-in **search-only** Python grading feedback, including the existing
   sandbox traceback. Reject requests for this feedback on a test-labelled task.
   Default grading results and the success criterion remain unchanged. Grading
   happens after the episode and does not feed assertions back into that episode.
2. Include selected parent round identity and per-task regression/improvement
   summaries in the MFlow mutation context. Preserve native AFlow parent sampling,
   validation repetitions, experience filtering, score selection and convergence.
   Missing historical summaries are unknown, never zero-filled.
3. Expose actual OBSERVE results and node errors through the existing application
   `ctx.structure` snapshot and route them to the dynamic policy. Do not copy raw
   inference requests and their recursively embedded histories into that view.
   Update the shared Ditto guide for searched and inference-time generated code.
4. Treat returned empty execution-error outputs as broken stages under the
   existing three-consecutive-failure recovery protection. Successful stages,
   agent count, search rounds and contexts have no new quota.
5. Clarify code-task instructions: preserve signatures and return contracts,
   distinguish supplied requirements from assumed expectations, execute finite
   checks, and revise only for an identified defect. Update mutation guidance to
   inspect actual parent source and prior regressions instead of adding a verifier
   to every failure. No benchmark-specific answer rules were added.

All agent inference, graph execution and tools still use the published Ditto
package. No Ditto source or private exports were changed.

## Validation and experiment protocol

Regression tests cover real sandbox assertion diagnostics and unchanged scores,
test-role rejection, observation/error routing through native Ditto graphs,
returned-error recovery, parent context, and complete per-task comparisons.
Scripted providers verify plumbing only, not benchmark quality.

This is a new execution/search version. Preserve the old run, costs and frozen
bundle. Start any new paid comparison in a separate immutable snapshot; evaluate
all 86 search tasks in each of the five passes per candidate, retain native AFlow
convergence, freeze the selected candidate, then test all 341 tasks once. Do not
resume the completed old controller under a mismatched manifest or selectively
rerun its failed test answers. No new paid search was launched by this repair.

Performance improvement is unmeasured. The changes do not guarantee that a future
candidate beats R1 or SingleLLM, and do not eliminate every possible malformed or
excessively long model generation.
