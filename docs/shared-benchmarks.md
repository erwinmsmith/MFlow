# 本地统一 benchmark 管理

更新日期：2026-09-30。本轮管理九个 benchmark 的已有本地资产，接入六个文本 benchmark。
未启动付费实验；GAIA/BFCL/τ³ 的交互 adapter 不在本轮范围。

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
- 新执行标识 v3.4.0。旧 bundle/运行继续使用当时保存的旧 runtime；不能用当前 build
  静默恢复旧搜索或重解释历史结果。manifest、数据锁和镜像 ID 会阻止不兼容恢复。

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
- 当前共享清单校验 1716 个文件；五个 AFlow 的十个转换文件保持原 SHA-256。
- 共享目录约 467 MiB：收藏/旧归档/Git 元数据 372 MiB，派生视图 212 KiB，Python 环境 95 MiB。
  Docker 镜像另计，逻辑大小约 269 MiB，基础层共享。
- 管理/转换测试、Ditto fixture 图执行、隔离评分正反例只验证工程接线，不代表模型成绩。
- 本机 `npm test`：104/104 通过，零跳过；Python 管理/转换测试：6/6 通过。
  六组 search/test 均通过完整锁、用途及评分预检查；DROP 控制器 fixture 验证按 F1 晋升，
  HumanEval+ 的正确/错误代码通过真实隔离 checker，未调用收费模型。
- 未启动新搜索、test 或模拟器付费调用。后续外部工具使用 Ditto 公开注册与 Interaction；
  普通逐任务隔离不要求复制事务基础设施，有通用包缺口再记录 Ditto 需求。
