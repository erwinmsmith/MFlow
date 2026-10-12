# Search v2: executable feedback for derivation policies

Historical protocol, superseded by [v3](search-v3.md) and the current [native search](dynamic-tools-and-topologies.md). Its experimental budgets are historical; the user later removed the shared 30M cap.

## Motivation and control

The original MATH root answered 88/119 validation tasks correctly but reported no deficits. A grammar filtered only by observed states could not propose DERIVE. A standalone derivation also lacked a guaranteed CONNECT/integration path; invalid actions could consume steps. This run did not demonstrate effective search.

The implementation borrowed optimization and MATH review/integration prompts from `FoundationAgents/AFlow@3f457218fc716093fe53f6df8a5d5e6379d66346`. Parent selection mixed 0.3 uniform exploration with temperature-0.05 softmax over the top four measured candidates. It retained the typed policy grammar, MIA, and affected-trace reuse rather than generating arbitrary Python workflows.

## Candidate operations

- `REVIEW`: independently review an owner's solution once, record `reviewed`, and revise or identify a concrete gap.
- `DERIVE -> CONNECT -> CONTINUE`: treat creation, evidence delivery, and integration as a complete local edit.
- `CHALLENGE -> CONNECT -> CONTINUE`: request an independent check even if the root reports no gap. Mark it as policy-requested verification, not proof that the answer is wrong. The independent factory/child receives no parent answer. Each owner is challenged at most once.
- Skip infeasible actions such as DORMANT or CONNECT without new artifacts. Runtime resource checks still apply.

The seed does not derive by default. Creating an agent is not itself a reward: promotion requires better complete validation performance within the resource protocol.

`src/prompts.ts` centralizes execution, review, factory, and optimizer instructions. Children must return checkable calculations, arguments, or counterexamples; only the owner can resolve its deficit after consuming evidence.

With `proposalMode: "aflow"`, the proposer receives the parent, measured validation accuracy, up to three failure traces, ten recent edits, and legal operation IDs. It returns at most four IDs. At this historical stage neither executor nor proposer receives reference answers. MIA uses measured paired outcomes, never model-invented quality/EIG. `proposalMode: "grammar"` remains a no-proposer control.

Progressive evaluation can reject harmful edits early; only complete affected-set evaluation permits promotion. Unchanged decisions reuse an observed parent trace, not a claim that a fresh stochastic execution would match it.

## Runtime and historical configuration

- Registry Ditto 0.1.1 only; duplicate Context/Infer message injection removed.
- DeepSeek JSON mode uses public provider options and strict schema validation. Non-truncation format errors get at most one answer-preserving Ditto repair, with all usage charged. Truncation ends the episode.
- Bundle v3 records execution version and prompt hashes. Older bundles require their original runtime.
- MATH remains 119 search / 486 test. Diagnostics use validation only.
- `configs/math-search-v2.json`: four candidate experiments, 800 task executions, 12M search tokens, 24k per episode, and 4096 output tokens. These were ceilings, not expected spend.
- A historical grader correction wraps plain-text gold answers consistently for math-verify, without guessing answers from explanatory prose. Reevaluate under a new run; do not attribute changes using old scores.

These historical configurations now belong to the explicit `legacy-search` path. Test follows freezing and must not guide candidate proposals or selection. Evaluation persists usage even on failure.
