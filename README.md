# MFlow — 搜索 agent 派生与组织策略

搜索一个可复用的组织策略 `π`；推理时，`π` 根据任务中的信息缺口动态组织不同能力的 agent。每个搜索节点是一套完整策略，每条搜索边是一处局部策略修改。

项目使用 npm 发布的 **`@codesoul-co/ditto@0.1.1`**。agent 的 Context、推理、工具调用由 Ditto Worker/Graph/Runtime 执行。没有本地 Ditto 源码依赖、私有路径导入、vendoring、Ditto monkey patch 或直接调用模型 SDK。

默认搜索直接调用外部固定版本 [FoundationAgents/AFlow 的 `3f45721`](https://github.com/FoundationAgents/AFlow/commit/3f45721) 优化器；模型和 agent 执行仍由发布的 Ditto 包负责。研究方案原文保存在 [docs/research-proposal.md](docs/research-proposal.md)，其中 MIA、部分评测和缓存方案已退出默认搜索。

## 当前实现范围

- 搜索完整 JavaScript 策略程序及 agent、factory、review、integrate、retrieve 提示词。程序读取任务运行状态，动态决定派生、复用、传递、整合和停止，不生成固定 agent graph。
- 官方 AFlow 的父节点采样、经验去重、失败样例、优化循环和收敛检测直接从固定源码导入；完整候选由 Ditto 中的优化模型生成，不从枚举 edit 列表挑选。
- 每个候选、每次重复都从头运行完整 validate。没有 MIA acquisition、affected-set 继承、前缀/agent 缓存、逐批淘汰或廉价候选替换规则。
- 默认不设优化轮数上限，按官方 top-3 均分连续五轮稳定判定收敛；每候选 5 次完整验证重复、50 题并发。无额外搜索总 token、单题 token、组织步数、agent 数或深度预算；保留供应商输出上限与 Python 工具执行隔离。
- Ditto Factory 开放生成不同 capability、objective、context、reasoning 和 tool manifest。可使用 arithmetic 和隔离 Python 工具，均通过发布包的 Interaction 执行。
- 标准协议每题重置状态；test 在选择冻结后才打开，答案只交给评分器。不同轮次/重复不共享模型执行结果。
- 每次请求保存 Ditto 用量账本；逐题结果和控制器状态可恢复。只有同一候选同一次重复的已完成题目可以在中断恢复时跳过。

实现与复现见 [官方 AFlow 搜索控制 v4](docs/search-v4.md)。旧的规则/MIA 实现仅保留在显式 `legacy-search` 入口供历史复现，旧结果不覆盖。历史协议见 [v2](docs/search-v2.md)、[v3](docs/search-v3.md)。

原有 standard/continual、BranchStore 和 checkpoint 能力保留；程序策略默认使用 standard，Python 工具不参与跨任务事务或前缀恢复。发布包边界与尚未满足的通用需求见 [Ditto 需求](docs/ditto-requirements.md)。

官方基线的独立运行协议见 [baseline 完整重跑协议](docs/baseline-rerun.md)。v4 默认验证重复次数为 5，当前旧 AFlow baseline 为 1，比较时必须报告这一计算量差异。

## 安装和验证

需要 Node.js 24+、npm 11+。

```sh
npm ci
npm test
npm run mflow -- doctor
```

若当前机器默认 Node 版本较旧，可临时使用 npm 发布的 Node 24：

```sh
npm exec --yes --package=node@24 --package=npm@11 -- npm ci
npm exec --yes --package=node@24 --package=npm@11 -- npm test
npm exec --yes --package=node@24 --package=npm@11 -- npm run mflow -- doctor
```

测试中使用脚本化 ModelProvider，但真实运行 Ditto 发布包的 Graph、Worker、推理与工具流。这验证系统协议与搜索实现，不代表任何模型或 benchmark 的实验结果。

## 数据准备

输入为 UTF-8 JSONL：

```json
{"id":"unique-id","prompt":"Task text","answer":"reference answer","metric":"exact","group":"optional-source-group"}
```

`metric` 支持 `exact`、`numeric` 以及下文的 benchmark 专用评分。搜索使用真实 0/1 分数；三分类成败后验仅属于历史 legacy-search。`group` 相同的任务必须进入同一个 split；ID 全局唯一，规范化 prompt 不能跨 split 重复。官方数据同一 split 内的重复题目保留。

```sh
npm run build
npm run mflow -- prepare --input data/example.jsonl --out data/prepared --seed 42
```

默认按 group 数量划为约 60% search、20% confirmation、20% test，实际样本量记录在 manifest。示例仅有 12 道手工算术题，用于格式检查，不是科研 benchmark。该 `prepare` 命令仅用于自定义数据。下面五个 benchmark 固定使用 AFlow 发布的划分，不经过此随机划分流程。

### 公开 benchmark

`benchmarks` 命令直接导入 **AFlow 发布的数据包**，保留 DROP、HumanEval、MBPP、GSM8K、MATH 的题目、顺序和 `validate/test` 归属。HotpotQA 不生成、不参与实验；上游压缩包内附带的 HotpotQA 文件不解压。转换仅用 Python 标准库，数学评分另需 `math-verify`：

```sh
python3.12 -m venv .benchmark-venv
.benchmark-venv/bin/python -m pip install -r requirements-benchmarks.txt
MFLOW_BENCH_PYTHON=.benchmark-venv/bin/python npm run mflow -- benchmarks --name all
npm run mflow -- benchmarks --name all --verify
```

也可把 `all` 改为单个数据集名称。划分固定，不支持 `--search-size`、`--confirmation-size` 或 `--seed`；已有目标目录时拒绝覆盖。`data/aflow.lock.json` 固定上游 commit、压缩包及 10 个源文件/转换文件的 SHA-256；各数据集的 manifest 记录来源和数量。运行时拒绝被裁剪或修改的 AFlow 数据文件。新数据包与转换后的五个数据集共约 **6 MiB**，不含 Python 环境和旧数据备份。

| 数据集 | 搜索：AFlow validate → search.jsonl | 最终评测：AFlow test → test.jsonl |
| --- | ---: | ---: |
| DROP | 200 | 800 |
| HumanEval | 33 | 131 |
| MBPP | 86 | 341 |
| GSM8K | 264 | 1055 |
| MATH | 119 | 486 |

五个数据集均不生成独立 confirmation。搜索、候选比较和策略选择使用完整 validate；冻结 `best.json` 后，`evaluate` 在完整 test 上运行并评分。`infer` 用于单条新问题。测试答案、推导和参考实现不会进入 agent prompt，MBPP 也不再附加隐藏评分断言。

**上游 DROP 自身含 5 对跨 split 重复题目，以及共享 passage。** 为复现原划分，保留这些题目，不改成按 passage 划分；程序仅放行锁定的 ID/prompt 组合，并在评测 summary 记录 `knownSourceOverlaps`。其他重复继续拒绝。不能把这份 DROP 划分描述成完全无重叠。完整来源、规则和评分差异见 [AFlow 数据协议](docs/aflow-data-protocol.md)。

代码评分需预先运行 Docker 并准备本地镜像：

```sh
docker pull python:3.12-alpine
```

评分经 Ditto 发布包的 `Sandbox` 接口调用 Docker：容器禁网、只读、非特权，并限制 CPU、内存、进程数与运行时间。缺少 Docker、镜像或数学评分依赖时，命令在模型调用前报错；不会把基础设施故障记成答错。不要在没有这些条件的机器上运行代码 benchmark 的搜索或评测。

## 搜索

复制 `.env.example` 为 `.env`，填写 API key、OpenAI-compatible endpoint 和实际模型名。凭据不进入搜索产物。

默认使用 DeepSeek Flash：`MFLOW_BASE_URL=https://api.deepseek.com`，`MFLOW_MODEL=deepseek-flash`。模型名和接口以 [DeepSeek 官方说明](https://api-docs.deepseek.com/guides/harness) 为准。`MFLOW_API_KEY` 只放在被 Git 忽略的本地 `.env`。DeepSeek 请求通过 Ditto 发布包的 OpenAI 兼容 Provider 发送，并使用其要求的 `max_tokens` 字段；当前默认关闭 DeepSeek thinking，以便结构化 JSON 输出遵守本项目的输出预算。`seed` 仅用于本地搜索/抽样，DeepSeek 请求不会发送该字段。

需要固定 AFlow checkout、其 Python 依赖环境，以及本地 Docker 的 `python:3.12-alpine` 镜像。现有 baseline 环境可以直接复用。镜像 ID、源文件哈希、配置、数据、编译代码和评分器均写入运行 manifest。

```sh
mkdir -p runs
npm run build
MFLOW_BENCH_PYTHON=.benchmark-venv/bin/python npm run mflow -- search \
  --search data/benchmarks/math/search.jsonl \
  --config configs/aflow-search.json \
  --source ../MFlow-baselines/sources/AFlow \
  --python ../MFlow-baselines/.venv-aflow/bin/python \
  --out runs/math-aflow-strategy \
  --test data/benchmarks/math/test.jsonl
```

`--test` 可省略；提供时仅在搜索结束并冻结 `best.json` 后开始 test。搜索中断后使用同一命令增加 `--resume`；代码、配置、镜像或数据变化会拒绝混跑。控制器源码来源和依赖准备见 [v4 文档](docs/search-v4.md)。

`configs/aflow-search.json` 的 `maxRounds:null` 表示只按收敛停止；设置正整数可显式启用兜底轮数。配置指定 5 次完整验证重复。官方 `Optimizer` 构造器默认 5 次，但其 `run.py` CLI 默认 1 次；本项目显式选择 5 次，没有把两者混称同一个默认值。每轮均保留重复分数，按官方方法计算平均分、选择父节点并检测收敛。

历史 MIA 配置改用 `legacy-search`，例如 `npm run mflow -- legacy-search --search data/prepared/search.jsonl --confirmation data/prepared/confirmation.jsonl --config configs/search.json --out runs/legacy-1`。它保留历史算法，不参与当前默认实验。

## 推理与测试

```sh
npm run mflow -- infer --bundle runs/search-1/best.json --question "What is 7 times 8?"
npm run mflow -- evaluate --bundle runs/search-1/best.json \
  --test data/prepared/test.jsonl --out runs/test-1
```

`best.json` 固定策略、模型配置、初始 profile pool 和运行预算。推理不读取搜索树。标准测试每道题重置 pool 和 episode，禁止跨题累计新 agent 或记忆。测试会拒绝与 search/confirmation 重复的 ID、规范化 prompt 或 group；唯一例外是上述 AFlow DROP 的 5 对固定源数据重复。

## 持续组织协议

只在需要跨任务积累能力和记忆时显式启用；搜索仍使用 standard 固定 pool，策略始终冻结。

```sh
npm run mflow -- evaluate --bundle runs/search-1/best.json \
  --test data/prepared/test.jsonl --out runs/continual-1 \
  --protocol continual --state-out runs/continual-1/canonical.json

npm run mflow -- infer --bundle runs/search-1/best.json --question "A new task" \
  --protocol continual --state runs/continual-1/canonical.json \
  --state-out runs/canonical-next.json
```

Consolidation 只接收任务输入与 agent 输出，不接收评分或参考答案。每次任务完成后由 Ditto 压缩程序性经验、选择保留的 agent，再在同一分支中提交 profiles、memory 和已见任务来源。无效输出/失败不会污染 canonical state。状态绑定 frozen bundle；重复任务或不兼容 bundle 会被拒绝。consolidation 单独计量，进入实际总用量，不能与 standard 准确率混为一组。

## 默认搜索产物

- `manifest.json`：冻结的官方源码、运行代码、数据、配置与 Python 镜像。
- `controller.json`：官方轮次、当前阶段、父节点经验以及 Python/NumPy 随机状态。
- `MATH/workflows/round_N/strategy.json`：完整策略程序与提示词；`experience.json` 保存原生父子经验。
- `MATH/workflows/results.json`：每轮每次完整重复的准确率与成本。
- `round-N/pass-K/`：逐题结果、完整执行轨迹、逐调用用量与尝试记录。
- `optimizer-calls/`、`proposals.jsonl`：优化模型调用成本与完整提案。
- `best.json`：冻结部署包；可供 `infer` / `evaluate` 使用。

### 历史 legacy-search 产物

| 文件 | 内容 |
| --- | --- |
| `config.json` | 参数、模型、Ditto 版本、数据内容哈希、初始 pool |
| `executions.jsonl` | 真实逐题执行、得分、trace、agent outputs、artifacts、tool events、逻辑 tokens/calls、actualTokens/actualCalls、可序列化 checkpoints |
| `decisions.jsonl` | 父/子节点、编辑、受影响任务、trigger rate、acquisition |
| `tree.json` | 完整策略、父子关系、评估/拒绝/中断状态 |
| `posterior.json` | correction / neutral / harm 的真实观测计数，不含先验 |
| `usage.json` | 底层 Ditto 预算记录，含 reservation、charge、known/unknown 状态及 run/branch/label；覆盖 factory、检索和 LLM 编辑选择 |
| `curve.jsonl` | 当前最佳 utility 对 search executions / tokens 的曲线数据 |
| `best.json` | 可直接推理的冻结部署包 |
| `errors.jsonl` | 实际执行异常；不会伪造 correctness observation |

仅 legacy-search 尚未实现断点续搜；默认原生 AFlow 搜索已支持 `--resume`。运行失败或预算中断会保留已执行数据。中断候选不具备晋升资格。

本轮发布、验证证据及剩余包需求见 [发布与接入记录](docs/release-2026-09-26.md)。
