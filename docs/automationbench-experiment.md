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


## SingleLLM：直接模型工具调用基线（2026-10-03）

新增可选 `SingleLLM`，复用既有 `seed --initialization single` 和并发 `evaluate`，
不执行搜索或根据测试结果选取提示词。固定一个 root：模型生成 → Ditto 工具调用/观察 →
继续生成，直到给出最终结果。没有独立 reviewer、subagent 派生或新工具创建。
这是一条单模型工具循环基线；AutomationBench 需要实际 API 状态改变，不能用一次纯文本回答代替。

- 与其他方法相同的 DeepSeek Flash、temperature 0、关闭 thinking，以及未搜索的任务专用提示词。
- 相同的 600 道 test、逐题重置的官方世界、API 发现/执行/base64 工具和官方评分。
- 模型调用和工具执行均使用 registry Ditto；每题完整成本、错误和断点由现有 evaluator 保存。
- 默认五框架调度不变；显式选择新增方法，独立输出目录避免与其他实验混写。

```sh
# 在已固定的代码快照中加载该实验的私有环境后运行；run 目录须独立。
python3 scripts/automation_experiment.py --benchmark automationbench \
  --methods SingleLLM --run runs/automationbench-single-llm \
  --concurrency 16
# 恢复已有运行时追加 --resume；查看进度使用 --status 和相同 --run。
```

冻结的初始 bundle 位于 `SingleLLM/seed.json`，结果/进度位于 `SingleLLM/test/`。
`--status` 显示该方法的通过率、部分得分、实际已知 token 与未知用量；无 search/optimizer 成本。
