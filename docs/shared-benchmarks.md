# 本地统一 benchmark 管理

更新日期：2026-09-30。管理十一个 benchmark 的本地资产，接入六个文本评测、HLE 多模态评测与 AutomationBench 官方交互环境。
GAIA/BFCL/τ³ 当前仅管理资产，交互 adapter 尚未接通。执行配置与支持范围见 [README](../README.md#llm-配置)。

## 共享目录

根目录：`/Users/erwin/Downloads/codespace/Benchmarks`。管理器的版本控制源在
[`benchmark-hub/`](../benchmark-hub/README.md)，部署后独立运行，其他项目无需导入 MFlow。
数据、凭据、环境和实验产物不提交到公开仓库。

```text
Benchmarks/
  bench.py                       # Python 标准库 CLI
  catalog.json                   # benchmark / 协议 / 来源 / 路径 / 接入状态
  manifests/files.json           # SHA-256 与大小
  collections/aflow-3f457218/     # 五个固定划分、原始下载与旧划分归档
  collections/official-20260930/  # GAIA、BFCL、τ³、HumanEval+、完整 MATH 来源
  views/humaneval-plus-aflow-v1/  # 继承 HumanEval ID 归属的扩展测试视图
  environments/text/             # math-verify 0.9.0；requirements.lock.txt
  state/                         # 后续环境输出与缓存；不修改固定数据
```

MFlow 的 `data/benchmarks` 和 Ditto 的 `benchmarks/data` 已替换为共享目录链接。
原路径、字节内容、实验结果和既有引用保持可读。Roy 本机没有另一份已下载的上述任务池；
可使用管理器导出的路径接入，远端 bundle 不在迁移范围。

```sh
python3 ../Benchmarks/bench.py list
python3 ../Benchmarks/bench.py verify
python3 ../Benchmarks/bench.py path math --split search
python3 ../Benchmarks/bench.py path humaneval_plus --split test
python3 ../Benchmarks/bench.py path bfcl --protocol raw
```

管理器更新后：`python3 benchmark-hub/bench.py install`。新机器先导入已有下载：
`import-local --mflow-data <五个AFlow数据目录> --official-data <官方资产目录>`。
当前入口不自动获取 GAIA 授权、不下载其他 release、不静默覆盖既有协议。
旧导入器仍可用 `benchmarks --name all --out <目录>` 下载并准备五个 AFlow benchmark。

## 数据与执行状态

| Benchmark | 来源 / 协议 | search / test | MFlow 状态 |
| --- | --- | --- | --- |
| DROP | AFlow `3f457218` | 200 / 800 | 可搜索、评测；搜索目标为平均 F1 |
| HumanEval | AFlow `3f457218` | 33 / 131 | 可搜索、隔离代码评分 |
| MBPP | AFlow `3f457218` | 86 / 341 | 可搜索、隔离代码评分 |
| GSM8K | AFlow `3f457218` | 264 / 1055 | 可搜索、最终数值评分 |
| MATH | AFlow `3f457218` | 119 / 486 | 可搜索、math-verify 评分；完整官方 test 另存 |
| HumanEval+ | EvalPlus v0.1.10；继承 AFlow HumanEval ID | 33 / 131 | 可搜索、官方 base+plus 评分；需镜像 |
| GAIA | HF `682dd723`；2023 validation 与附件 | 尚未制定 MFlow 划分 | 仅管理资产，官方 test 未下载 |
| BFCL | V4 checkout `6ea57973` | 原类别与会话保留 | 仅管理资产与官方工具/评分代码 |
| τ³ | v1.0.1 / `fc0055dc` | 保留原 split 结构 | 仅管理资产与官方环境/评分代码 |
| HLE | `cais/hle@5a81a4c7`；官方 evaluator `22ed3074` | 官方 2500 test；另有自定义 200 search / 2300 test | 全部图片、五框架 actor 和官方 prompt/schema 的 Ditto judge 已接入 |
| AutomationBench | Zapier 1.0.6 / `4a8e1061`，API toolset | 200 simple / 600 public domain | 官方环境、工具与断言评分已接入 |

GAIA 的附件及 gated 条件见[官方数据卡](https://huggingface.co/datasets/gaia-benchmark/GAIA)。
BFCL 单轮、多轮、Memory 和 Web Search 保留各自协议；本机 commit 不等于在线排行榜的
checkpoint。[官方说明](https://gorilla.cs.berkeley.edu/leaderboard)
τ³ Knowledge 与 Voice 分别需要检索和实时音频接口，保存 checkout 不等于已经可以执行。
[官方仓库](https://github.com/sierra-research/tau2-bench)

## MFlow 入口

```dotenv
BENCHMARK_HOME=../Benchmarks
MFLOW_BENCH_PYTHON=../Benchmarks/environments/text/bin/python
MFLOW_EVALPLUS_IMAGE=mflow-evalplus:0.1.10
```

```sh
npm run build
npm run mflow -- benchmarks list
npm run mflow -- benchmarks --verify
npm run mflow -- benchmarks path --name HumanEval+ --split test

# 以下命令会调用模型，需要明确实验授权。
npm run mflow -- search --benchmark gsm8k --config configs/aflow-search.json --out runs/gsm8k-search
npm run mflow -- evaluate --benchmark gsm8k --bundle runs/gsm8k-search/best.json --out runs/gsm8k-test
```

直接单模型对照可复用同一执行器，无需搜索：

```sh
npm run mflow -- seed --benchmark drop --initialization single --out runs/drop-single/seed.json
npm run mflow -- evaluate --benchmark drop --bundle runs/drop-single/seed.json --out runs/drop-single/test --concurrency 16
# MBPP 将 drop 换成 mbpp；需要本地 python:3.12-alpine 评分镜像。
```

DROP/MBPP 的 single 使用任务专用输出契约，只执行一个 root，不派生、不提供工具、
不创建工具。MBPP 的隐藏测试仅由评分器执行，不回传模型。DROP 报告平均 F1 和 F1=1
的比例；MBPP 报告单次生成的测试通过率。模型参数和提示词保存在 seed bundle，原始
调用用量（含重试）保存在 `test/task-usage`。中断后用相同 evaluate 命令加 `--resume`。

显式 `--search` / `--test` 路径仍支持；与 `--benchmark` 同时提供时，显式路径优先。
加载器接受 `benchmark:math/search`、`benchmark:humaneval+/test`，并发脚本也可使用。
GAIA/BFCL/τ³ 请求 search/test 视图会明确报错，避免把“有数据”误认成“执行已接通”。

### 修正现有使用方式

- 官方 AFlow 控制器的 dataset / question type 随任务确定，不再全部保存到 MATH。
- MATH/GSM8K 使用数学种子；DROP 使用阅读理解种子；HumanEval/MBPP/HumanEval+
  使用完整 Python 输出契约。不同 benchmark 独立搜索，不能直接复用 MATH Round 2 为通用策略。
- 非数学 seed 使用 `ctx.publishText(id,text,'raw')`，保留完整答案，包括代码里的字面 boxed 表达式。
  原数学种子的 boxed 默认行为保留。
- DROP 默认搜索优化平均 F1，逐题二元成功另保留；最终报告 accuracy 和 meanF1。
  五对已知上游跨集重复题仍保留，见 [AFlow 协议](aflow-data-protocol.md)。
- 当前执行标识 v3.6.1。旧 bundle/运行继续使用当时保存的旧 runtime；不能用当前 build
  静默恢复旧搜索或重解释历史结果。manifest、数据锁和镜像 ID 会阻止不兼容恢复。

### DROP / MBPP 全方法适配（2026-10-08）

统一入口 `scripts/automation_experiment.py --benchmark drop|mbpp` 支持 MFlow、AFlow、
DyLAN、EvoAgent、AutoAgents、SingleLLM。沿用 `aflow-fixed-v1` 的完整划分：

| benchmark | search | test | 选择目标 / test 指标 |
| --- | ---: | ---: | --- |
| DROP | 200 | 800 | 平均 F1；另报 F1=1 的比例 |
| MBPP | 86 | 341 | 单次最终代码通过率（pass@1） |

每种方法验证相同 split 哈希。保留上游 DROP 的 5 组已登记 prompt 重叠，
不能将它描述为完全无重叠的数据集；不重新划分或将 test 成绩用于选择。

- **算法保持不变**：MFlow 仍是一棵树、一个 single-agent root；父节点采样、经验反馈、
  单次修改、5 次重复验证、收敛停止、冻结最佳候选及最终 test 均复用现有控制器。
  AFlow 沿用同一原生优化控制器；DyLAN 的辩论/剪枝/一致性、EvoAgent 的专家演化、
  AutoAgents 的 Manager/observer/Action 流程未替换。三者直接完整 test。
- **多样性来自搜索分支**：DROP 鼓励证据定位、指代/时间关系、计数及独立计算；
  MBPP 鼓励规格分析、不同算法、边界检查及可执行验证。可搜索并行、树状、交叉复核及
  异构内部 graph，不新建多个初始化搜索树，也不强制派生。test 使用冻结后的同一动态策略、
  模板与 Ditto node 说明，仍可创建新 subagent/工具。
- **任务输出与环境**：DROP 输出简洁答案，MBPP 输出原始完整 Python；移除数学 boxed
  提示与数学答案提取。AFlow 使用官方 DROP/MBPP 的 Custom、ScEnsemble 算子及提示模板。
  DROP 的 ScEnsemble 仅接收 solutions，MBPP 另接收 problem。
- **工具与数据边界**：所有框架的执行 actor 可通过发布版 Ditto 使用 arithmetic/Python；
  MFlow 可按现有权限规则创建/共享工具。Python 禁网、隔离执行、保留时间和资源保护。
  AutoAgents 的自定义搜索只返回当前题的公开内容，不联网寻找答案。
  AFlow 不开放读取数据集测试的原生 Test 算子；MBPP hidden tests 仅用于最终评分，
  执行阶段只用公开例子或自主构造的检查。SingleLLM 保持原来的单调用、无工具设置。
- **结果与恢复**：沿用逐题结果、token 账本、冻结配置和 supervisor 恢复；DROP 状态输出另含
  meanF1。只在搜索完成后 test，不运行逐轮观察 test。这里的离线检查验证工程接线，
  不代表这些方法在两套数据上的真实准确率。

保持此前 DeepSeek Flash 参数：temperature=0，thinking disabled，seed=42（DeepSeek
请求不发送 seed），max output=393216；不增加搜索轮数、总 token 或 agent 数量额度。
DROP 默认模型并发 32，MBPP 16；legacy 进程并发单独设置以控制内存。
需先准备两个原生 Python 环境（`../MFlow-baselines/.venv-aflow`、`.venv-legacy`）、
注册表发布的 Ditto 包及本地 `python:3.12-alpine` 镜像。桥接器启动时先验证数据与评分环境。

```sh
# 在代码快照目录、配置好私有 .env 后运行；以下命令会启动付费实验。
export MFLOW_MODEL=deepseek-flash
export BENCHMARK_HOME=/Users/erwin/Downloads/codespace/Benchmarks
python3 scripts/automation_experiment.py --benchmark drop --run runs/drop-comparison \
  --methods MFlow AFlow DyLAN EvoAgent AutoAgents SingleLLM --legacy-concurrency 4
python3 scripts/automation_experiment.py --benchmark mbpp --run runs/mbpp-comparison \
  --methods MFlow AFlow DyLAN EvoAgent AutoAgents SingleLLM --legacy-concurrency 2
# 独立端口默认为 DROP 8200 / MBPP 8201；查询不启动实验。
python3 scripts/automation_experiment.py --benchmark drop --run runs/drop-comparison --status
# 相同快照和配置下断点续跑：原启动命令附加 --resume。
```

## HLE 与 AutomationBench

```sh
python3 benchmark-hub/bench.py install
python3 ../Benchmarks/prepare_extra.py automationbench
python3 ../Benchmarks/prepare_extra.py hle
python3 ../Benchmarks/bench.py verify

# 不访问数据、不调用模型：导出未搜索的初始 MAS。
npm run mflow -- seed --benchmark hle --out runs/hle-seed.json
npm run mflow -- seed --benchmark automationbench --out runs/automation-seed.json

# 下列命令会调用模型，需另行授权实验。
MFLOW_HLE_JUDGE_MODEL=deepseek-flash npm run mflow -- evaluate --benchmark hle \
  --bundle runs/hle-seed.json --out runs/hle-text-test
npm run mflow -- search --benchmark automationbench --config configs/aflow-search.json --out runs/automation-search
npm run mflow -- evaluate --benchmark automationbench \
  --bundle runs/automation-search/best.json --out runs/automation-test
```

固定来源与 split 哈希见 [`data/extended-benchmarks.lock.json`](../data/extended-benchmarks.lock.json)。
HLE 的整个官方 Parquet（274,276,147 bytes）已通过授权浏览器下载；现有 HF token 的文件
访问仍返回 403，换机器时需让下载 token 具备该 gated repo 权限，也可授权浏览器下载到
`collections/hle/raw/data/test-00000-of-00001.parquet` 后再运行准备命令。

HLE 只有官方 test。保留原始 `hle-text-test-v1`，新增 `hle-full-test-v1`（2500 题、342 图片题、无 search），
以及 `hle-full-holdout-v1`（分层 200 search / 2300 test，28 / 314 图片题）。
按类别、答案类型与模态以 seed 42 最大余数分配，SHA256(42:taskId) 排序；题目/图片组合不跨划分。
这是单独命名的自定义实验协议，不能将其 test 分数称为官方完整 HLE 成绩。
完整五框架实验使用后者，详细运行、工具与 judge 差异见 [HLE experiment](hle-experiment.md)。
复用固定官方 system/judge prompt 与判定 schema（MIT，Copyright 2025 centerforaisafety；许可见 LICENSE）；judge 经 Ditto INFER Worker 执行，
参考答案仅给 judge。必须显式设置 `MFLOW_HLE_JUDGE_MODEL`，并由同一配置 endpoint 提供；
固定官方 evaluator 默认 judge 为 `o3-mini-2025-01-31`，改用 DeepSeek 必须披露，不能直接等同官方评分。
逐题保存 judgement/confidence 与 judge 用量，summary 当前报告 accuracy，未报告 calibration error。
用量账本中的 `hle-judge` 单独标识评分成本，计入实际总 tokens。

[AutomationBench 官方仓库](https://github.com/zapier/AutomationBench)提供 600 道公开领域任务、
200 道不计正式分数的 simple 任务；官方排行榜另用私有集。本地明确命名
`automationbench-public-simple-v1`：simple 用于开发搜索，六个领域全部用于冻结后 test。
这是 MFlow 开发协议，不是官方提供的 train/test，也不是私有排行榜。
所有题目、顺序、断言、API schema 和允许服务使用固定官方代码；search/test ID、prompt、group 检查无重叠。

官方 `AutomationBenchEnv.setup_state` 初始化每题 world，`update_tool_args/call_tool` 分发模拟 API，
`partial_credit/task_completed_correctly` 评分（严格模式遇到断言错误报基础设施故障）。
`api_search/api_fetch/base64_encode` 以 `RegisteredTool` 注册到 Ditto `createInteractionWorker`，
由 `INTERACTION.ACT.TOOL/OBSERVE` 执行；未调用官方 OpenAI/Anthropic agent runner。
同一 MAS 的成员共享该题 world；每次新题/重试重置官方 world。Python 进程只复用导入和任务构建缓存，
没有模型输出或跨题环境缓存。执行快照保存 world/contract，评分失败后重评同一状态，避免重新抽模型。
不启用有外部副作用工具的前缀缓存；continual 入口明确拒绝此协议。
官方 strict pass 是主报告，partial credit 另列，未伪装成 F1。

本次磁盘 `du`：HLE collection 约 272 MiB、文本 view 约 2.7 MiB；AutomationBench collection
约 488 MiB（其中官方锁定 Python 环境约 447 MiB），view 约 1.1 MiB。均为本机实测，
不包含全局 uv/Hugging Face 下载缓存、模型权重或未来实验日志。
本轮未启动付费模型实验；离线 fixture 通过只证明接线、数据隔离与评分恢复，不代表模型效果。

## HumanEval+ 评分

原始数据和转换锁在 [`data/humaneval-plus.lock.json`](../data/humaneval-plus.lock.json)。
官方 evaluator commit：`26d6d00bb1fd0fa37f39c99d5290da67891d1c5e`。
HumanEval+ 没有独立官方 train/test；这里继承 AFlow HumanEval 的 ID 归属和顺序，
prompt 使用 EvalPlus 版本。不能将原 HumanEval 和 HumanEval+ 视为独立任务族。

只向 agent 提供 `id/prompt`。canonical_solution、扩展输入、原测试、contract 及评分元数据
留在评分侧。跨协议检查将两个 benchmark 的同一个 HumanEval/N 视为同题，拒绝用于选择后
换一个 benchmark 名称再作为 test。所有完整 split 必须匹配锁定 SHA-256。

镜像使用固定官方 EvalPlus 模块；调用 `trusted_exec` / `untrusted_check`，保留 oracle、
特殊断言、容差、默认动态时间规则及 base+plus 测试，成功要求两组均通过。
[EvalPlus 官方实现](https://github.com/evalplus/evalplus)

```sh
docker build -f ../Benchmarks/Dockerfile.evalplus -t mflow-evalplus:0.1.10 \
  ../Benchmarks/collections/official-20260930/HumanEval+
```

本机 Docker Hub 连接超时，本轮加 `--build-arg BASE_IMAGE=ditto-bench-tools:1` 使用已有
Python 工具基础镜像。实际评分模块来自固定 EvalPlus checkout，优先于基础镜像的其他版本；
未调用 Ditto checkout 运行代码。镜像 ID：
`sha256:711af2250184feca6ab9fbfef678febbbfb90f667fc58e0455feb01dcb495f1d`；
numpy 1.26.4 / psutil 7.2.2。实验固定镜像 ID，不能只记录可变 tag。

评分通过发布包 Ditto Sandbox 调用禁网、只读、非特权容器，保留代码执行保护。
基础设施失败抛错，不算模型答错；模型输出先保存，修复评分后可重评相同答案。
新 manifest 加入镜像、原始数据和评分脚本哈希。

## 存储与验收

- 迁移前校验旧官方清单 1945 个条目（含归档条目），核对三个官方 checkout revision。
- 当前共享清单校验 2313 个文件；五个 AFlow 的十个转换文件保持原 SHA-256。
- 共享目录当前约 1.2 GiB；新增 HLE 与 AutomationBench 约 764 MiB。原迁移资产约 467 MiB。
  Docker 镜像另计，逻辑大小约 269 MiB，基础层共享。
- 管理/转换测试、Ditto fixture 图执行、隔离评分正反例只验证工程接线，不代表模型成绩。
- 本机完整工作树 `npm test`：108/108 通过，零跳过；Python 管理/转换测试：6/6 通过。
  六组 search/test 均通过完整锁、用途及评分预检查；DROP 控制器 fixture 验证按 F1 晋升，
  HumanEval+ 的正确/错误代码通过真实隔离 checker，未调用收费模型。
- 未启动新搜索、test 或模拟器付费调用。后续外部工具使用 Ditto 公开注册与 Interaction；
  普通逐任务隔离不要求复制事务基础设施，有通用包缺口再记录 Ditto 需求。

### DROP/MBPP execution repair (2026-10-08)

The search object remains the complete MAS candidate: outer composition and dynamic
spawn/routing policy, initial single-root profile/binding, heterogeneous agent
programs/templates and their node capabilities, reusable tools and prompts. Native
AFlow parent sampling, experience filtering, five validation repeats and convergence
are unchanged. Each child inherits its selected historical parent's complete
artifact and measured executions; rounds are tree extensions, not independent
initializations. Only search feedback selects the final frozen candidate; test runs
once after search and executes that same dynamic policy from a single root.

Engineering failures found in the first DROP/MBPP run:

- An optimizer placed an agent-local program (`ctx.self`) in the outer MAS. Runtime
  `PolicyContractError` during search evaluation now becomes a persisted failed
  candidate row and optimizer feedback. Provider/grader infrastructure failures
  still suspend evaluation without fabricating a score. The optimizer receives an
  explicit outer-MAS versus bound-agent return/context contract reminder.
- BusyBox timeout running as container PID 1 left Python graders alive after the
  Docker client deadline. Python tools/graders now use Docker `--init`, unique names
  and independent cleanup. Candidate timeout/OOM exit 137 scores zero; Docker startup
  failures and client timeouts remain resumable infrastructure errors. An already
  saved answer is regraded without a new model generation.
- Exact repeated action/result cycles receive recovery guidance, then an execution
  error if they continue unchanged. Different arguments or observations remain
  unrestricted; no search, token, context or useful-action budget was introduced.
- AutoAgents role JSON/reference serialization repair now stops after three failed
  repair calls. Control/ranking/formatting calls no longer receive the benchmark's
  final-answer-only instruction, which conflicts with their native schemas.

Continuation uses checksum-verified application-module repair receipts on the
original frozen snapshots (`scripts/evaluation_io_repair.mjs` and
`scripts/baseline_contract_repair.py`). No Ditto package or upstream baseline source
is patched. Each run retains `runtime-repairs.json`, the exact replacements and
checksums, original manifests, controller/RNG state, completed rows and all prior
usage. Completed rows are not selectively rerun; interrupted uncommitted work may
restart and its earlier usage remains in the ledger. Thus results are an explicitly
recorded repaired continuation, not a claim that all rows used one unchanged
runtime. Any new clean comparison should use the repaired version for every method.

Follow-up on 2026-10-08: AFlow MBPP repeated the same randomized Python test
hundreds of times; changing random counterexamples defeated action-plus-result
matching. The transport guard now also detects unchanged `python`/`arithmetic`
arguments, including short multi-action cycles. Four repetitions produce explicit
recovery guidance; continued repetition fails the node as `DEGENERATE_OUTPUT`.
Changed code/arguments remain unrestricted, and stateful external tools are excluded
from this additional check. A failed task remains a failure, not a fabricated final
answer. Progress records identify which cycle check triggered. The regression uses
Ditto's public `runReactFlow`, real infer/interaction workers and a scripted fixture
provider; it verifies execution behavior only, not model quality.

For generated nodes choosing JSON mode, the resolved HTTP request now receives the
required JSON output instruction when absent. Existing schemas, text-mode calls,
model parameters, native search and MAS mutation procedures are preserved. This
prevents deterministic missing-JSON HTTP 400 errors from restarting a whole search
pass. A second checksum-recorded repair receipt preserves the earlier repair history.
