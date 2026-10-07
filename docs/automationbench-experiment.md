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

## MFlow 编排执行修复（2026-10-05）

v11 搜索中发现两类实际代码错误：Round 4 对同步 `ctx.spawnTemplate` 使用 `yield*`，
以及生成程序经子 agent 返回同一个仍在执行的 root 程序，递归重复已执行的工作。
共享编译入口现在用已有 TypeScript 解析器检查同步 helper 的错误委托，交由既有候选
contract repair 在批量评测前纠正；源码字符串和注释不会被误判。共享 `runAgent` 入口
拒绝同一成员、同一程序尚未返回时的重入，并在退出时清理记录；顺序复用、切换程序和
派生其他成员仍可执行。搜索及 inference 使用同一检查和 Ditto 接口说明。

修复必须使用新的代码快照和 run，不把旧分数并入新搜索。旧 Round 3 的 98.90% 是
五次搜索验证的平均成绩，并非 test 成绩；仍保持搜索结束选取最优结构后才做最终 test。
回归检查覆盖实际的同步 helper 错误及 root→child→root 递归，并验证已完成写操作不重放。

2026-10-06：原生 graph 执行的 Context/编排契约异常现在通过暂停中的 generator 返回
当前阶段，使其错误处理在原任务世界内运行；供应商认证、余额和网络故障仍向上报告。
回归用真实 Ditto Context 节点复现超过公开 inline 上限的消息，并验证恢复只执行一次写操作。
DITTO-006 的包能力需求仍待支持。按用户要求，修复版保持准备状态，暂不启动付费实验或 test。

2026-10-07：用户已启动 Round 3 test。供应商明确报告的两种 tool 消息配对 HTTP 400
现在作为生成程序的阶段契约错误返回，保留真实观察供当前阶段修复；不补造工具结果，
其他 HTTP/网络错误仍向上报告。切回模板后保留生成程序的执行来源，后续契约失败也能
保存当前世界并由官方评分器评分，不因活动程序绑定被移除而丢失已完成的写操作。
两项回归检查覆盖上述路径。按用户要求，当前题目继续执行，修复通过带校验和的应用模块
替换记录供下一次自动续跑使用；已完成结果保留，仅重试未提交结果的题目。冻结的 Round 3
策略、提示词和 Ditto guide 不变，修复版本单独记录，不将这批 test 结果用于搜索。

## Round 3 固定异构 / 同构 MAS 对照（2026-10-07）

用户要求比较已搜索候选的固定 MAS。以冻结的 Round 3 `s3` bundle 为来源，
不重新搜索，也不从 test 轨迹挑选生成的 subagent。其模板库只有 solver、verifier。
两组都固定执行 root/solver → verifier → root 修复，共两个成员、三次成员程序执行；
每个成员内部仍可多轮调用模型与工具。此路由是消融设计，并非另行搜索出的最优静态结构。

| 变体 | 内部程序与能力 |
|---|---|
| `fixed-heterogeneous` | 保留 solver、verifier 各自冻结的 graph/loop、节点、工具权限与 reasoning 配置 |
| `fixed-homogeneous` | 两者统一使用 solver 的 graph/loop、节点、工具权限与 reasoning 配置；保留各自职责和私有指令 |

两组都有相同的证据流：verifier 读取执行结果并只读检查，root 读取验证结果，仅修复未完成工作。
固定外层路由不调用动态派生工厂；原工具创建开关、工具库和所有全局提示词保留。
同构不是完全相同的角色提示词。原两模板的图拓扑已经接近，主要差异是执行权限和角色配置，
因此不能将成绩差异单独解释为 graph 拓扑的影响。

使用同一组 600 道公开 test、DeepSeek Flash、temperature 0、seed 42、Ditto 0.1.2，
每题官方世界隔离，评分与原动态 Round 3 一致。沿用 v11 冻结 actor、原 Ditto guide 和
已校验的 `8d1907c` 应用 composition 修复；不改 Ditto 包。两个变体各并发 16 道题。
源 bundle SHA256：`e264b1f603a36857d1b6ad90a46544f4330caad52f34a8c8265f7f856d746756`。
这是既有 test 上的消融，不是新的独立 holdout；结果不进入后续搜索或提示词选择。

准备命令（分别使用不存在的新 OUT 目录）：

```sh
node scripts/prepare_ablations.mjs --source "$SOURCE" --out "$OUT" --variant fixed-heterogeneous
# 另一独立 OUT 使用 --variant fixed-homogeneous。
# 从源实验的冻结 actor 目录、私有环境及 repair loader 启动：
node --env-file-if-exists=.env dist/src/cli.js evaluate --benchmark automationbench \
  --bundle "$BUNDLE" --out "$TEST_OUT" --concurrency 16
# 中断后相同命令加 --resume，保留所有已完成题（包括错题）。
```

每组的 `task-usage/*.json` 保存所有模型请求、失败与重试用量；`summary.json` 保存最终
已知 token、未知 usage 请求数和准确率。输入、输出、缓存输入的分项来自原始 usage，
缓存输入属于输入的一部分，不重复相加。未知请求的预算预留值不当作实际用量，存在未知
usage 时实际总 token 只能报告下限。新增 test 成本与原搜索成本分开记录。
运行索引、冻结 bundle、修复收据及重启脚本位于独立实验目录，入口记录在
`runs/current-experiments.json` 的 `localDeepSeek.automationbenchMFlowAblations`。
仅保留必要的成绩、用量、结构证据与恢复文件，定期清理过期请求诊断。
