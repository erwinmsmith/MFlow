# AutomationBench / DeepSeek Flash comparison

> The multi-root description below documents historical frozen experiments. Current MFlow starts from one root agent and explores descendant MAS structures within one search tree; see [the current protocol](dynamic-tools-and-topologies.md). Existing runs are not silently migrated.

2026-10-02: DeepSeek comparisons moved to [local parallel snapshots](local-deepseek-20261002.md) after hb became unreachable. Use that document for the active progress commands; server snapshots below remain historical records.

Current deployment: [2026-10-01 recovery](server-recovery-20261001.md). The v4 snapshot resumes saved evaluations with sequential methods and 8 concurrent MFlow/AFlow episodes, retaining Qwen. The v2/v3 deployment details below describe the historical runs; use the recovery document's commands for current progress.

## Protocol

All five methods use the locked `automationbench-public-simple-v1` views: 200 simple tasks for development/search, followed by all 600 public domain tasks for held-out evaluation. This is a documented cross-domain development protocol, not an official training split or private leaderboard submission. Task IDs, data hashes, source hashes and dependencies are checked before execution. Test tasks and private rubric/state never enter search, mutation or actor prompts.

Every episode starts a fresh official world. All actors within that episode share it. Only the published Ditto package executes model requests and registered external tools (`api_search`, `api_fetch`, `base64_encode`). Official AutomationBench 1.0.6 scores actual world changes; final prose is not execution evidence. Report both strict pass rate and mean partial credit.

Model: `deepseek-flash`, temperature 0, thinking disabled. Output allowance is 393216 tokens; no experiment token ceiling, search-round ceiling, agent-count or derivation-depth quota. Generated-code and external execution guards remain. The existing Qwen service is retained.

## Search and execution

- **MFlow:** five measured roots: single executor, executor/reviewer, plan/execute, parallel complementary planners/execute, and a task-local adaptive factory. Every root receives five complete 200-task validation passes before becoming eligible as a parent. Descendants use the original AFlow optimizer's parent sampling, experience, validation and convergence control. Mutations inherit complete MAS configuration, bindings, graphs and prompts.
- **AFlow:** original static Workflow, Custom and ScEnsemble operators; three measured roots: single, plan/execute and review. The same native optimizer and five full validation passes apply. Python operator model calls are transported through Ditto; generated workflows cannot import host capabilities or access private state. Programmer is not an AutomationBench operator.
- **DyLAN:** original population, rounds, ranking, pruning and consensus; workflow evidence replaces math-only answer normalization/examples.
- **EvoAgent:** original role evolution, retention, collaboration and refinement; workflow instructions replace boxed math output.
- **AutoAgents:** original role design, observer, execution plan and group loop. Its custom search interface invokes the benchmark's official API discovery tool through Ditto.

DyLAN, EvoAgent and AutoAgents run all 200 development episodes, then all 600 test episodes. Their role creation within an episode is native inference work, rather than cross-task statistical search. Planning prompts require reasoning without writes; MFlow planning profiles and baseline ranking/role-design calls disable tools. Actors receive identical API tools. Original baseline sources are pinned and verified, not edited in place.

MFlow uses five roots and AFlow three: search compute is therefore not equal. Search, optimizer, retries, development and test usage are retained separately; compare accuracy together with measured cost. No test results select a round or prompt. The selected bundle/workflow is frozen before test.

Inference freezes the **policy**, not the realized MAS. `ctx.spawn(profile, parentId, composition)` can compile a new task-local subagent program outside the template library, then `yield* ctx.runAgent(id, assignment)` executes it with public Ditto nodes. Profiles can differ in tool access, reasoning and graph/loop design. Generated sources, actual graphs, bindings and lifecycle events are retained in each execution. These programs never alter the frozen bundle or survive into another test task.

## Remote execution and progress

Each experiment runs from a separate immutable snapshot under `hb:/home/b/project/experiments/`. Source, build, configuration and dependency hashes are saved in `experiment-manifest.json`. Qwen MATH and DeepSeek AutomationBench use separate snapshots, outputs, profiles and bridge ports (8198 and 8197 respectively). Shared datasets and Python environments are outside code sync. Local code remains authoritative for `/home/b/project/MFlow` and must pass `bash scripts/sync_hb.sh` checksum verification.

From the DeepSeek snapshot directory:

```bash
bash scripts/hb-model.sh deepseek python3 scripts/automation_experiment.py
python3 scripts/automation_experiment.py --status
bash scripts/hb-model.sh deepseek python3 scripts/automation_experiment.py --resume
```

The 2026-09-30 snapshot is `/home/b/project/experiments/deepseek-automation-20260930-v2/MFlow`. Query it directly from a local terminal:

```bash
ssh hb 'cd /home/b/project/MFlow; python3 scripts/automation_experiment.py --status --run /home/b/project/experiments/deepseek-automation-20260930-v2/MFlow/runs/automationbench-deepseek-flash-20260930-v2'
ssh hb 'systemctl --user status mflow-deepseek-automation-20260930-v2 --no-pager'
ssh hb 'systemctl --user status mflow-deepseek-autoagents-20260930-v3 --no-pager'
ssh hb 'systemctl --user status mflow-deepseek-aflow-20260930-v3 --no-pager'
ssh hb 'systemctl --user show mflow-deepseek-shared-bridge-20260930-v3 --property=ActiveState --property=SubState'
```

The runner starts all five methods, then automatically advances each from search/development to the full test set. Initial concurrency is 24 MFlow episodes, 12 AFlow episodes and one worker process for each of the other methods, leaving more RAM for the retained Qwen service. Official worlds are multiplexed in one Python bridge per Node process to avoid repeating imports for every episode. LLM requests remain concurrent; benchmark API requests are short, serialized local operations.

Outputs live in `runs/automationbench-deepseek-flash-20260930-v2/`: `jobs.json`, one log per method, `bridge.log`, `usage.jsonl`, request progress, per-task world checkpoints and results. `--status` reports phases, current round/pass, completed counts, correct counts, token accounting and transport activity. Completed rows are preserved. If only scoring fails, the saved world is regraded without new model calls. Provider/infrastructure failures stop the affected stage and remain visible; they are not recorded as ordinary wrong answers.

Resume requires the same immutable snapshot and configuration. It reuses completed tasks, partial validation passes and frozen selection; it does not reinterpret partial roots as converged search. A code repair requires an explicitly recorded new snapshot/run. Scripted providers in local checks only verify contracts and isolation; they are not benchmark performance evidence.

### AutoAgents capability correction

The v2 development run exposed a role planner claiming API writes were unavailable. The planner now receives the actual actor capabilities: registered API discovery and read/write tools execute through Ditto, while role design and observer calls still cannot execute tools. Native role and action formats remain unchanged. This change uses only development feedback; test has not selected prompts.

Only AutoAgents restarts, from `/home/b/project/experiments/deepseek-autoagents-20260930-v3/MFlow`, with all 200 development and 600 test episodes. It reuses the unchanged v2 Ditto bridge at port 8197 to avoid another resident benchmark process. `MFLOW_BASELINE_EXECUTION_NAMESPACE=autoagents-capabilities-v3/` gives it fresh worlds/checkpoints. `MFLOW_BASELINE_RUN_DIRECTORY`, `MFLOW_BASELINE_USAGE_PATH` and `MFLOW_BASELINE_TRANSPORT_ROOT` select its separate output and the actual bridge ledger/source. Each phase manifest hashes both client and server code; changing either refuses resume.

The v2 output's `method-outputs.json` points the current status command to the replacement. It retains the stopped original job and all original cost, and reports replacement cost separately. AutoAgents v2 quality rows are excluded from v3 accuracy. Resume v3 by starting its own user service after fixing infrastructure; it preserves completed rows and advances development to test only on success. The shared bridge must remain active until v3 finishes; check both services before a resume.

AFlow also resumes with the repaired client in this snapshot: malformed/degenerate model output is an episode execution failure, graded against the resulting world, rather than an HTTP infrastructure outage. Its unchanged workflows, prompts, native search controller and 199 completed evaluations are copied with an explicit `recovery.json` provenance receipt; the original manifest is retained separately and the new manifest hashes the actual client and unchanged shared server. The failed remaining world's state is checkpointed and graded without replaying successful writes. Future model-output failures use the same path, while provider HTTP/network errors still stop the run. Test remains untouched.

The bridge's AFlow output points to the repaired client's output so native workflow freezing sees the new candidates and writes selection metadata where the controller reads it. The original directory is archived as `AFlow-v2-before-client-recovery`; all existing world checkpoints are preserved. The original immutable source is unchanged.

The shared-bridge standby service waits while the original five-method runner is active. It starts no additional Node/benchmark process during this wait. If that runner finishes before the repaired pipelines, standby stops those clients, launches the exact same immutable bridge/configuration/ledger, then resumes the two clients once. Completed evaluations remain fixed; interrupted tasks with no committed world checkpoint restart from a fresh official world, and their original request costs remain in the ledger. This is infrastructure recovery, not selection by test outcomes. Stop the standby service before intentionally stopping the entire comparison.

## Initial startup attempts

The first `a447e90` snapshot is retained separately as a preflight attempt, not combined with formal accuracy results. Real calls exposed a missing output parent directory and argument validation escaping the native tool observation path. The repaired adapter keeps the official schema, returns a public failed ExternalResult with detailed content and a safe error message, and lets native Ditto observe and repair the call. Prompts explicitly require JSON strings/null for API params/body. An integration check executes invalid arguments, model repair and successful official grading. Formal v2 starts all five methods from scratch after this change; held-out tasks have not been evaluated or used for repair.

Preflight usage, interrupted request records and checkpoints remain under the original snapshot. Known usage and requests interrupted before usage was returned must be reported separately; their exact token charge is unavailable. Resume v2 from its own immutable snapshot, rather than importing preflight quality rows.


## SingleLLM direct tool-use baseline (2026-10-03)

The optional SingleLLM method reuses `seed --initialization single` and concurrent evaluate. One root samples, executes/observes tools through Ditto, and continues until a final response. It has no search, reviewer, derived subagent, or generated tool. AutomationBench requires actual API effects; a single prose answer is not an equivalent baseline.

It uses the same DeepSeek Flash, temperature 0, thinking-disabled setting, unsearched task-specific prompt, 600 test tasks, fresh official worlds, API tools, and grader. Requests, costs, errors, and checkpoints use the common evaluator. Select it explicitly with an independent run directory:

```sh
python3 scripts/automation_experiment.py --benchmark automationbench \
  --methods SingleLLM --run runs/automationbench-single-llm --concurrency 16
# Add --resume for the same frozen run; use --status with the same --run.
```

The frozen seed is SingleLLM/seed.json, with progress/results in SingleLLM/test. There is no optimizer/search cost.

## MFlow composition repairs (2026-10-05 to 2026-10-07)

V11 exposed `yield*` applied to synchronous spawnTemplate and recursive root -> child -> still-running root delegation. The shared compiler uses the existing TypeScript parser to reject synchronous-helper delegation before batch evaluation, without matching source strings/comments accidentally. runAgent rejects reentry into the same active member/program and clears its guard on exit. Sequential reuse, program changes, and other-member delegation remain valid. Search and inference use the same guide/checks.

Changed semantics required a new snapshot/run. Historical round 3's 98.90% was the five-pass search mean, not test. Regressions cover malformed helper delegation and recursion without replaying completed writes.

On 2026-10-06, native Context/composition contract failures were returned to the suspended generator so recovery could operate in the same world. Authentication, balance, and network faults still propagate. A real Context overflow fixture verified recovery with only one write; the underlying DITTO-006 capacity gap remains. At that point the user requested preparation without paid execution.

On 2026-10-07 the user started round-3 test. Two explicitly identified provider tool-message pairing HTTP-400 errors became stage contract failures with real observations available for repair. No tool outputs are fabricated; other HTTP/network errors propagate. Generated-program provenance survives rebinding to a template, allowing later contract failures to save/grade the world rather than lose effects. Current tasks were allowed to finish; a checksummed application-module repair was recorded for the next resume. Completed rows, round-3 strategy/prompts/guide, and prior costs remain preserved. Test results do not enter search.

## Round-3 fixed heterogeneous/homogeneous ablations (2026-10-07)

Both variants derive from the frozen s3 bundle; they do not search again or select generated subagents from test trajectories. Its library contains solver and verifier. The prescribed route is root/solver -> verifier -> root repair: two members, three program invocations, with arbitrary internal model/tool turns. It is an ablation route, not a separately searched optimal static graph.

| Variant | Internal programs and capabilities |
| --- | --- |
| fixed-heterogeneous | Preserve each frozen solver/verifier graph, nodes, tool permissions, and reasoning |
| fixed-homogeneous | Use solver's graph/nodes/tools/reasoning for both; preserve role objectives/private instructions |

Both pass execution evidence to a read-only verifier and its observations to root for unfinished-work repair. The outer route does not call the dynamic factory. Global prompts, tool creation, and libraries stay inherited. Homogeneous does not mean identical role prompts. The original graphs were already similar; outcome differences cannot be attributed solely to topology.

Both use the same 600 tasks, DeepSeek Flash, temperature 0, seed 42, Ditto 0.1.2, fresh worlds, and original grader. The v11 actor/guide and recorded `8d1907c` composition repair are frozen. Concurrency: 16 per variant. Source bundle SHA-256: `e264b1f603a36857d1b6ad90a46544f4330caad52f34a8c8265f7f856d746756`. This reuses an existing test set and is not a new independent holdout.

```sh
node scripts/prepare_ablations.mjs --source "$SOURCE" --out "$OUT" --variant fixed-heterogeneous
# Use a different new OUT and fixed-homogeneous for the other variant.
# Execute from the source experiment's frozen actor with its environment/repair loader:
node --env-file-if-exists=.env dist/src/cli.js evaluate --benchmark automationbench \
  --bundle "$BUNDLE" --out "$TEST_OUT" --concurrency 16
```

Resume with the identical command plus --resume, retaining wrong answers as well as correct ones. task-usage files retain all requests, failures, and retries. summary.json reports known tokens, unknown calls, and accuracy. Cached input is a subset of input, not an extra additive category. Reservations are not actual usage; unknown calls make known tokens a lower bound. New test cost is separate from search. The local run index is `localDeepSeek.automationbenchMFlowAblations`. Retain essential scores, usage, structure, and recovery evidence; clean obsolete request diagnostics.
