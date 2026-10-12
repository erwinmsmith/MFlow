# Search v8: complete text reasoning and recoverable dynamic organizations

Historical MATH protocol. Current search is documented in [dynamic tools and topologies](dynamic-tools-and-topologies.md).

V8 jointly searched the MAS controller, internal graph/loop programs, profiles, templates, and prompts using upstream AFlow. Roles could specialize in decomposition, alternative mathematics, independent derivation, counterexamples, computation, inter-agent graphs, or recursive delegation.

## Transfer initialization

The local AFlow MATH round 12 scored 118/119 validation tasks. It solved once, then gave the original question and complete derivation to a second reasoning call for revision, without requiring MFlow's claims/artifacts/deficits JSON. V7-02 scored 94/119 on its first pass and stopped during the incomplete second pass after repeated child output.

V8 used AFlow round 12's validation-selected solver/reviewer prompts as editable initialization:

1. Root runs Context -> Sample and returns a complete text solution.
2. A reviewer receives the question and full derivation; its program is Sample only.
3. Matching final answers stop. Disagreement, missing answers, or node failure derives an independent alternative-method solver with Context/Sample/Tool/Observe and arithmetic/Python. It does not initially receive prior answers.
4. Agreement with existing answers returns a result; remaining disagreement routes complete derivations to integration. If all executions fail, an empty answer is graded normally.

These are editable seed rules, not a fixed role catalog. String agreement controls routing, not mathematical correctness; the common grader still decides equivalence. Full solutions are artifacts and search failure evidence. `publishText` extracts the last balanced boxed answer; `textMessages` includes actual objectives, capabilities, reasoning, output contracts, and stopping criteria. Public provider options select text/JSON formats; deployment parameters stay frozen.

**This is transfer initialization from AFlow validation search.** It is not independent, compute-matched cold-start search. Report the source prior and its upstream search cost separately. AFlow test was not used for initialization.

## Failure boundaries

DEGENERATE_OUTPUT, INVALID_MODEL_OUTPUT, INCOMPLETE_MODEL_OUTPUT, and provider output exhaustion become node errors for the searched program to handle. The seed can choose another agent rather than replaying root/the entire task or accepting truncated evidence. HTTP, authentication, and transport infrastructure failures preserve checkpoints; successful sibling nodes cannot erase them.

Python failures use a short safe `error.message` and complete diagnostics in public content, propagated through OBSERVE. Tool-message multipart content is serialized without dropping fields. Previously placing multiline stderr in error.message violated package validation and retried the whole task; a real-container regression covers this boundary.

Prompt guidance stops after decisive review. Code isolation and exact-repeat detection remain, while long nonrepeating responses are not truncated by application length caps. Grading retries the saved answer only. Missing usage keeps actualTokens null; reservations are not measured consumption.

Fresh search used MATH 119/486, five full repetitions, upstream sampling/experience/convergence, and no additional experiment budget. V7/diagnostic scores were not inherited. Parent artifacts and actual execution graphs were inherited together. Historical regression: 86 tests passed; two HTTP-422-triggering validation tasks completed correctly with three and two tool calls, excluded from new search scores.

## Tool and persistence boundary at the time

V8 used registry Ditto 0.1.1 for isolated arithmetic/Python. Generating code for one Python call did not yet constitute registering a reusable persistent tool. DITTO-005 tracked general tool definitions, permission checks, isolated registration, and reload; later public-package support is recorded in [requirements](ditto-requirements.md). Standard tasks never inherit another task's answer or mutable world state.

## Historical concurrent test

`scripts/evaluate_concurrent.mjs` is a historical text/MATH runner, not the current BFCL evaluator. It schedules independent standard tasks using the selected frozen runtime, bundle, model, and grader. Each task has its own provider and ledger; reference answers go only to grading.

```sh
node --env-file=.env scripts/evaluate_concurrent.mjs \
  --runtime runs/EXPERIMENT/frozen-dist/src \
  --bundle runs/EXPERIMENT/frozen-current-best/best.json \
  --test data/benchmarks/math/test.jsonl \
  --out runs/EXPERIMENT/frozen-current-best/test \
  --concurrency 50 --resume
```

Resume identifies completed task IDs, preserves wrong answers, and permits out-of-order completion. Infrastructure failures remain unfinished. Executions, rows, task usage, and requests are stored separately. Full completion produces summary.json; otherwise partial-summary.json. Do not resume concurrent output using the older ordered-prefix serial runner. When migrating a serial run, stop it first and preserve serial-usage.json and serial-interruption.json, including unobserved usage.

## Repairs on 2026-09-30

- Invalid Python arguments return PYTHON_ARGUMENTS observations without starting a container. Public execute results carry repairable failures because Ditto 0.1.1 validate exceptions otherwise terminate the node.
- Sandbox command timeout becomes PYTHON_TIMEOUT; user/runtime cancellation still propagates. The 30-second code and 40-second command protections remain.
- Exact-repeat detection checks multiple match positions, periods up to 8192 characters, at least eight repetitions spanning 8192 characters, within a 128 KiB diagnostic window. This does not truncate model input/output or use gold answers.
- Connection reset, broken pipe, connection timeout, and abnormal terminated responses receive at most two retries after one and two seconds. Each original-request retry has separate reservation/settlement; partial text is not joined to a successful response. Authentication, cancellation, format errors, and repetition faults are not automatically retried.

Execution version became `mflow-native-library-v3.3.1/tool-input-observations-transport-recovery`. The already-selected round 2 was retested over all 486 tasks in a separate run. Old results were retained, not mixed. Report that its original validation scores used the earlier runtime.

## Search/test audit

The 2026-09-30 audit found no shared task IDs, normalized prompts, or groups between 119 search and 486 test tasks; hashes matched AFlow. All 689 failure feedback records came from search. No test IDs appeared in search requests and no search calls followed freezing. The selected round-2 bundle matched execution. Freeze: 04:25:30 UTC; first test: 04:26:00 UTC. Executors received IDs/questions, graders received references.

This supports absence of direct test-to-search data leakage in that run, not a claim of never-observed test data across the project. Earlier v2/v3 runs had used the same MATH test. Later development based on those scores must be disclosed; a new predeclared holdout is needed for independent generalization claims. Pretraining contamination and semantic near-duplicates were outside this audit.
