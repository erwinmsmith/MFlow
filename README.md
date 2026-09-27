# MFlow — 搜索 agent 派生与组织策略

搜索一个可复用的组织策略 `π`；推理时，`π` 根据任务中的信息缺口动态组织不同能力的 agent。每个搜索节点是一套完整策略，每条搜索边是一处局部策略修改。

项目使用 npm 发布的 **`@codesoul-co/ditto@0.1.1`**。agent 的 Context、推理、工具调用由 Ditto Worker/Graph/Runtime 执行。没有本地 Ditto 源码依赖、私有路径导入、vendoring、monkey patch 或直接调用模型 SDK。

原 AFlow 实现已清理；参考基线为 [FoundationAgents/AFlow 的 `3f45721`](https://github.com/FoundationAgents/AFlow/commit/3f45721)，原许可证保留。研究方案原文保存在 [docs/research-proposal.md](docs/research-proposal.md)。

## 当前实现范围

- 类型化、有序规则 DSL：`CONTINUE / REACTIVATE / DERIVE / CONNECT / DISCONNECT / DORMANT / STOP`。
- Ditto 组合的 agent 执行器：独立 objective、capability、private context、reasoning 和 tool manifest。Factory 依据 deficit 开放生成 agent，不使用固定 verifier/programmer 角色表。
- `MISSING / LATENT / ACTIVE / DELIVERED / RESOLVED` 状态；artifact 定向传递；只有 owner 能关闭自己的 deficit。
- 按真实 utility 选择父节点；局部修改；逐步评估；完整受影响集合评估后才能晋升；可选独立 confirmation。
- MIA 方向过滤、真实成败观测的 Dirichlet 后验、Monte Carlo 信息增益选择；五种消融配置。
- 固定种子且保留 group 边界的数据划分、manifest、标准答案隔离、test overlap 检查、冻结策略推理。
- 每个任务从相同不可变 profile pool 开始。可重用预先提供的 dormant profile，也可在任务内派生与失活。

新增 Ditto 发布包能力已接入：

- `prefixCache:true`（默认）在 parent/child 第一个决策分歧之前恢复显式 episode 状态，只执行 suffix；checkpoint 包含资源/配置版本与完整性校验。
- `agentCache:true` 可缓存同一任务、profile、上下文、配置和资源版本下的完整 agent turn，最多保留 256 项，默认关闭。回放保留逻辑 token 成本，新增模型成本为零。
- Ditto `TokenBudget` 对 search 和 episode 预留、结算和记录 provenance。缺失 usage 保守扣留预留量并报错；默认按 UTF-8 输入字节数 + 最大输出 + 1024 估计，**未经 provider 上界验证，不能承诺物理硬 token 上限**。
- standard 每题重置；另有显式 `--protocol continual`，通过 Ditto 生成压缩记忆，并原子提交 profile、memory 和任务来源到 `BranchStore`，可导出和恢复 JSON 状态。

当前隔离范围为显式 JSON 状态与内置纯算术工具。注入其他工具时，缓存、prefix 恢复与 continual commit 会拒绝运行，直至接入经过验证的资源隔离适配器。

详见 [Ditto 通用能力需求](docs/ditto-requirements.md) 和 [架构与实验协议](docs/architecture.md)。

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

`metric` 支持 `exact`、`numeric` 以及下文的 benchmark 专用评分。搜索使用 0/1 分数，对应三分类成败后验。`group` 相同的任务必须进入同一个 split；ID 全局唯一，规范化 prompt 不能跨 split 重复。官方数据同一 split 内的重复题目保留。

```sh
npm run build
npm run mflow -- prepare --input data/example.jsonl --out data/prepared --seed 42
```

默认按 group 数量划为约 60% search、20% confirmation、20% test，实际样本量记录在 manifest。示例仅有 12 道手工算术题，用于格式检查，不是科研 benchmark。已有官方 split 的数据直接转换为三个 JSONL，保持原 split，不要再次随机划分。

### 公开 benchmark

`benchmarks` 命令下载并转换 **DROP、HumanEval、MBPP、GSM8K、MATH**，不会下载 HotpotQA。需 Python 3.12+；MATH 转换需 `pyarrow`，评分需 `math-verify`。可用独立虚拟环境：

```sh
python3.12 -m venv .benchmark-venv
.benchmark-venv/bin/python -m pip install -r requirements-benchmarks.txt
MFLOW_BENCH_PYTHON=.benchmark-venv/bin/python npm run mflow -- benchmarks --name all
```

也可把 `all` 改成 `drop`、`humaneval`、`mbpp`、`gsm8k`、`math` 单独准备。默认每个训练集抽取 64 道 search、16 道 confirmation，完整保留官方测试集；`--search-size`、`--confirmation-size`、`--seed` 可调整。`data/benchmarks/<name>/manifest.json` 记录来源 URL、SHA-256 与划分数量。目标目录已有转换结果时命令拒绝覆盖。当前机器五个数据集的原始和转换文件共约 **37 MiB**；独立 Python 环境约 **161 MiB**，Docker 镜像另计。

| 数据集 | 搜索 / 确认 / 测试 | 评分与划分 |
| --- | ---: | --- |
| DROP | 86 / 19 / 9535 | train 按 passage 抽样；dev 作最终测试；多标注答案的 EM 用于搜索，同时记录 DROP F1。源数据含空答案和一个重复 ID，转换时剔除。 |
| HumanEval | 0 / 0 / 164 | 只有官方 test；使用别的代码训练集选好策略后才评测；容器内运行 `check(entry_point)`，记录 pass@1。 |
| MBPP | 64 / 16 / 500 | 官方 task ID：601–974 train、511–600 validation、11–510 test；在容器内运行提供的断言，记录 pass@1。 |
| GSM8K | 64 / 16 / 1319 | 官方 train/test；提取 `####` 后最终数字，按数值评分。 |
| MATH | 64 / 16 / 5000 | EleutherAI 的 Hendrycks MATH 镜像 train/test；使用 `math-verify` 检查数学等价性。 |

HumanEval 和 MBPP 的参考测试只留在评测记录，Ditto agent 只接收题目 prompt。MBPP 原始题目附带的公开示例断言保留在 prompt 中。代码评分需预先运行 Docker 并准备本地镜像：

```sh
docker pull python:3.12-alpine
```

评分经 Ditto 发布包的 `Sandbox` 接口调用 Docker：容器禁网、只读、非特权，并限制 CPU、内存、进程数与运行时间。缺少 Docker、镜像或数学评分依赖时，命令在模型调用前报错；不会把基础设施故障记成答错。不要在没有这些条件的机器上运行代码 benchmark 的搜索或评测。

## 搜索

复制 `.env.example` 为 `.env`，填写 API key、OpenAI-compatible endpoint 和实际模型名。凭据不进入搜索产物。

默认使用 DeepSeek Flash：`MFLOW_BASE_URL=https://api.deepseek.com`，`MFLOW_MODEL=deepseek-flash`。模型名和接口以 [DeepSeek 官方说明](https://api-docs.deepseek.com/guides/harness) 为准。`MFLOW_API_KEY` 只放在被 Git 忽略的本地 `.env`。DeepSeek 请求通过 Ditto 发布包的 OpenAI 兼容 Provider 发送，并使用其要求的 `max_tokens` 字段；当前默认关闭 DeepSeek thinking，以便结构化 JSON 输出遵守本项目的输出预算。`seed` 仅用于本地搜索/抽样，DeepSeek 请求不会发送该字段。

```sh
mkdir -p runs
npm run mflow -- search \
  --search data/prepared/search.jsonl \
  --confirmation data/prepared/confirmation.jsonl \
  --config configs/search.json \
  --out runs/search-1
```

输出目录必须尚不存在，避免覆盖旧实验。默认所有 agent 使用同一模型；能力差异来自 Ditto 推理组织、上下文和工具。当前注册工具为 `arithmetic`。可通过 `DittoAgents` 注入其他 Ditto `RegisteredTool`，但没有隔离契约的工具只能用于关闭缓存的普通执行，不得据此宣称具有事务回滚能力。

配置 `variant` 可选：

| 变体 | MIA 方向限制 | MIA acquisition | 实际表现评估 |
| --- | --- | --- | --- |
| `random` | 否 | 否，随机编辑 | 真执行 |
| `llm-guided` | 否 | 否，Ditto 中的模型选择合法编辑 | 真执行 |
| `mia-space` | 是 | 否，随机编辑 | 真执行 |
| `mia-acq` | 否 | 是 | 真执行 |
| `mia-full` | 是 | 是 | 真执行 |

所有变体的父节点选择都基于真实 utility。LLM 不给 agent、边或编辑打数值分。`--pool profiles.json` 可提供冻结初始 profile；必须含唯一 `root`。默认只含 Root。

## 推理与测试

```sh
npm run mflow -- infer --bundle runs/search-1/best.json --question "What is 7 times 8?"
npm run mflow -- evaluate --bundle runs/search-1/best.json \
  --test data/prepared/test.jsonl --out runs/test-1
```

`best.json` 固定策略、模型配置、初始 profile pool 和运行预算。推理不读取搜索树。标准测试每道题重置 pool 和 episode，禁止跨题累计新 agent 或记忆。测试会拒绝与 search/confirmation 重复的 ID、规范化 prompt 或 group。

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

## 产物

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

运行失败或预算中断会保留已执行数据；当前未实现自动断点续搜。中断候选不具备晋升资格。

本轮发布、验证证据及剩余包需求见 [发布与接入记录](docs/release-2026-09-26.md)。
