# AFlow 固定数据划分

## 来源与映射

基准为原仓库 commit [`3f457218`](https://github.com/FoundationAgents/AFlow/tree/3f457218fc716093fe53f6df8a5d5e6379d66346)。其 [`data/download_data.py`](https://github.com/FoundationAgents/AFlow/blob/3f457218fc716093fe53f6df8a5d5e6379d66346/data/download_data.py) 指定的 `aflow_data.tar.gz` 已下载核实。压缩包 SHA-256 为 `7089a373c27184ae1b67e322f8276642dab246359052989b03a27f48251ae053`；逐文件校验值固定在 [`data/aflow.lock.json`](../data/aflow.lock.json)。

[`scripts/evaluator.py`](https://github.com/FoundationAgents/AFlow/blob/3f457218fc716093fe53f6df8a5d5e6379d66346/scripts/evaluator.py) 中 `is_test=False` 读取 `<dataset>_validate.jsonl`，`is_test=True` 读取 `<dataset>_test.jsonl`，两者 `va_list=None`，即读取整个文件。`validation_rounds` 是重复评估次数，不是额外划分一份数据。

| Benchmark | 原 validate → MFlow search | 原 test → MFlow test | 总计 |
| --- | ---: | ---: | ---: |
| DROP | 200 | 800 | 1000 |
| HumanEval | 33 | 131 | 164 |
| MBPP | 86 | 341 | 427 |
| GSM8K | 264 | 1055 | 1319 |
| MATH | 119 | 486 | 605 |

这些是发布包的实际数量，不能用原始数据集的官方 train/test 数量或理想的 20%/80% 四舍五入重新生成。特别是 MBPP 的 427 题和 MATH 的 605 题子集必须原样保留。MFlow 不重排、不抽样、不去重、不补齐。

- **搜索**：使用完整 `search.jsonl`，即 AFlow validate。初始策略完整评估；候选按 MFlow 的渐进评估及可复用轨迹规则运行，只有覆盖完整搜索集合的结果才能晋升。搜索算法与 AFlow 不同，数据池保持相同。
- **确认/选择**：AFlow 没有独立 confirmation。本协议不生成该文件，也禁止给 AFlow 搜索额外传 `--confirmation`。候选选择始终依据 validate。
- **最终 inference/evaluation**：先冻结 `best.json`，再对整个 `test.jsonl` 使用 `evaluate`，每题重置组织状态，只把 `id/prompt` 发给 agent；答案与测试断言仅供评分器读取。测试分数不反馈搜索。
- **单题推理**：`infer --question` 接收新问题，不读取 benchmark 答案。
- **持续组织实验**：`continual` 允许跨题更新组织状态，是独立实验协议；与 AFlow 对齐的基础评测使用默认 `standard`。

数据文件携带 `aflowSplit=validate/test`。加载时检查完整转换文件的 SHA-256，拒绝裁剪、修改或拼接的文件；用途检查拒绝 test 用于搜索、validate 用于最终评测，以及通过 `prepare` 重划分。seed 只影响策略搜索，不改变 benchmark 划分。

## 题目和参考答案

转换保留 AFlow benchmark 传给 graph 的输入文本，不附加参考答案、推导或隐藏断言：

| Benchmark | agent 输入字段 | 仅评分器可见 |
| --- | --- | --- |
| DROP | `context` | `ref_text`；`|` 按 AFlow 表示答案替代项 |
| GSM8K | `question` | `answer`；不向 agent 传 `cot` |
| MATH | `problem` | `solution` |
| HumanEval | `prompt` | `test`、入口函数；不导入 `canonical_solution` |
| MBPP | `prompt` | `test`、`test_imports`；不向 prompt 追加 `test_list` 或 `code` |

保留源 ID 并增加 benchmark 命名空间；MATH 无源 ID，以 problem 的 SHA-256 作为稳定 ID。按源顺序一一转换，manifest 保存来源和数量。上游 `*_public_test.jsonl` 是部分 operator 可使用的公开测试辅助池，不是额外的评测 split，本实现没有导入或启用该 operator。压缩包内含 HotpotQA，但不解压或生成该数据集。

## DROP 的上游重叠

原发布包按问题划分，validate/test 共享 120 个 passage 文本；此外有以下 **5 对规范化后相同的题目**，test 内还有 8 个重复 prompt（额外记录数）：

| validate ID | test ID |
| --- | --- |
| 563 | 5145 |
| 5872 | 7202 |
| 8540 | 4560 |
| 3024 | 871 |
| 131 | 3879 |

保持 AFlow 一致性需要保留它们。因此本协议不添加 passage group、不移除重复题目，也不宣称 DROP 是完全无重叠的 held-out 数据。评测仅为锁定的这五对 ID 与 prompt hash 放行，输出 `knownSourceOverlaps`；相同 ID、其他 prompt 重叠或自定义 group 跨集仍会报错。其他四个 benchmark 未发现跨 validate/test 的规范化 prompt 重叠。

## 评分边界

本次对齐保证题目、划分、输入字段与评测标签一致，不等于完全复刻 AFlow 的执行与评分环境：

- GSM8K 按 AFlow 取输出最后一个数字，使用数值容差。
- DROP 记录 AFlow 的最大 token F1（预测和参考均按 `|` 分割取最大值）。MFlow 三分类后验仍需要二元成功，`score=1` 仅当 F1=1；因此 MFlow 的二元搜索 utility 不能与 AFlow F1 搜索 utility 混称一致。最终结果同时报告 `accuracy` 和 `meanF1`。
- HumanEval/MBPP 使用同一源文件的测试函数；MFlow 经 Ditto Sandbox 在隔离 Docker 容器中执行，代码处理和超时与 AFlow 本地线程评分器不同。
- MATH 使用 `math-verify`；AFlow 使用自己的数学等价判断实现。因此数值结果不应宣称与 AFlow 评分器完全等价。

## 准备、验证和运行

```sh
npm run build
npm run mflow -- benchmarks --name all
npm run mflow -- benchmarks --name all --verify
npm run mflow -- search --search data/benchmarks/gsm8k/search.jsonl \
  --config configs/aflow-search.json --out runs/gsm8k-search
npm run mflow -- evaluate --bundle runs/gsm8k-search/best.json \
  --test data/benchmarks/gsm8k/test.jsonl --out runs/gsm8k-test
```

准备与离线验证不调用模型。Docker 和数学依赖仍按 README 准备。`configs/aflow-search.json` 只是有限预算示例；搜索因预算停止时不缩小数据集，未完整评估的候选不得晋升。原小样例 `configs/search.json` 的 200 次预算不足以完整评估 GSM8K 基线。

2026-09-27 本机旧划分已备份至忽略目录 `data/benchmarks/legacy-official-splits-20260927/`，新固定划分使用正常的五个数据集目录。旧的 64/16 抽样及完整官方 test 结果不能与这份协议混用，原先 HumanEval 仅供测试的描述已作废。

## 本次验证记录

- 10 个转换文件与锁定校验值一致；3515 条记录逐条对照上游的顺序、prompt、答案/测试函数，全部一致。
- 五组 search/test 均通过 schema 和用途检查；只有锁定的 5 对 DROP prompt 重叠被放行。
- Node 24 下 `npm test`：32/32 通过，包含实际 Docker 代码评分测试。
- 参考答案评分检查：DROP 1000/1000、GSM8K 1319/1319；抽查 MATH 4/4、HumanEval 7/7、MBPP 6/6（包含函数补全、辅助函数和导入依赖）。这些是数据与评分接线检查，不是模型成绩。
- 本次未调用 DeepSeek 或执行付费搜索实验，默认模型仍为 Flash。
