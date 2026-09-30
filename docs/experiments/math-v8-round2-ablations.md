# MATH Round 2：dynamic / fixed MAS / single 对照

## 冻结设计

本对照由用户明确请求，使用当前已选中的 Round 2 模板库，不重新搜索，不根据 test 成绩挑选策略或调整提示词。

| 变体 | 固定的执行路由 |
|---|---|
| dynamic（已有结果） | root → reviewer；分歧时 independent；仍有分歧时 checker；必要时 root 整合 |
| single（新完整测试） | 仅 root/solver 完整求解 |
| fixed-full（新完整测试） | root → reviewer → independent → checker → root 整合；答案一致也不提前退出 |
| fixed-uniform（新增完整测试） | 同 fixed-full 路由；所有成员共享 independent 的内部图、节点权限、react 模式和 arithmetic/Python 权限 |

fixed-full 使用四个不同能力成员，执行五次成员程序；工具循环可以增加模型调用次数。它是原候选的固定路由消融，不是另外搜索出的最优静态 MAS。single 是相同 root 的消融；root 原有 profile 不允许工具，不能解释为有工具的单 agent 最优系统。

fixed-uniform 保留各角色目标、能力描述、private_context 和五段全局提示词，但统一内部执行程序。它同时给原无工具的 root/reviewer 增加工具权限，所以是同构执行能力的对照，不是只改 graph 源码的单变量实验。该结构由用户追加请求，未针对已观察 test 错题选择或修改任何提示词。

所有组不变项：deepseek-flash、temperature=0、同一 global prompts、角色目标和私有方法指令、Ditto 0.1.1、v3.3.1 执行运行时、486 道固定 MATH test、原 grader 和 Python 镜像、执行保护。single/fixed-full 还保留原 profile 的图与工具权限；fixed-uniform 按上文统一这些能力。模型没有访问 test 标准答案，每题状态隔离。

independent 始终只读取原题和原独立求解指令，未接收其他成员推导。reviewer 读取 root 完整推导；checker 读取前三者的完整有效推导；最终 root 读取四者的完整有效推导，使用原 integrate 提示词。保留原候选的整合空答案回退顺序。

动态结果已完成：469/486。新两组从空目录重新测试全部题目，不复用旧模型答案。路由程序在调用新 test 前冻结。此 MATH test 已被历史实验使用，这份报告属于既有 benchmark 的消融对比，不能作为全新独立 holdout 的泛化证据。

## 代码与复现

- 路由变换：`src/ablations.ts`。只替换 composition 与标识，保留完整 profile/template/prompts。
- bundle 准备：`scripts/prepare_ablations.mjs`。不读取 test 数据，不调用模型，记录原 bundle 与新 bundle 哈希。
- 执行：现有 `scripts/evaluate_concurrent.mjs`，使用源实验的冻结运行时，而不是新生成的执行引擎。
- 回归：`test/ablations.test.ts` 用脚本 provider 验证 single 只有 root、fixed 在一致答案时仍执行所有成员、独立输入与证据整合正确、标准答案未进入请求。它不提供真实模型质量证据。

```sh
node scripts/prepare_ablations.mjs \
  --source runs/math-v8-round2-test-repaired-20260930-02/best.json \
  --out runs/math-v8-round2-ablations-20260930-01

MFLOW_BENCH_PYTHON="$PWD/.benchmark-venv/bin/python" \
node --env-file=.env scripts/evaluate_concurrent.mjs \
  --runtime runs/math-v8-round2-test-repaired-20260930-02/frozen-dist/src \
  --bundle runs/math-v8-round2-ablations-20260930-01/single/best.json \
  --test data/benchmarks/math/test.jsonl \
  --out runs/math-v8-round2-ablations-20260930-01/single/test \
  --concurrency 25
```

fixed-full 使用相同命令，将路径的 single 改为 fixed-full。两组各并发 25，总共并发 50；并发度只控制题目调度，不改变每题 MAS。中断后用相同命令添加 `--resume`，已完成的错误答案也保留，评分失败复用已保存的模型执行。

新增组准备时使用 `--variant fixed-uniform --out runs/math-v8-round2-uniform-20260930-01`，执行对应 `fixed-uniform/best.json`，输出到 `fixed-uniform/test`，使用 `--concurrency 50`；前两组继续执行，不取消未完成模型请求。

最终报告按同一 task ID 比较准确率、配对的纠正/退步题数、已知 token 和未知 usage 请求。基础设施失败只记未完成，不改写成错误答案。未知 usage 的预算预留数不视为供应商实耗。


## 完整结果（2026-09-30）

四组均完整测试相同 486 道题。动态组使用此前完成的冻结 test；新三组全部重新生成。

| 组别 | 正确题数 | 准确率 | 已确认 token | 缺失 usage 请求 |
|---|---:|---:|---:|---:|
| single | 453/486 | 93.21% | 898,284 | 14 |
| dynamic | 469/486 | 96.50% | 1,943,722 | 26 |
| fixed-full（异构） | 477/486 | 98.15% | 9,327,251 | 36 |
| fixed-uniform（同构） | 478/486 | 98.35% | 14,711,775 | 38 |

已确认 token 包含缓存输入；有未知 usage，以上均为实际总用量的下限。预算账本包含未知请求预留量，不是实际收费。新增三组已确认总计 24,937,310 token，另有 88 次请求缺失 usage；不包含搜索开销。

配对比较：dynamic 相对 single 纠正 20 题、退步 4 题，净增 16 题；fixed-full 相对 dynamic 纠正 12 题、退步 4 题，净增 8 题；fixed-uniform 相对 dynamic 纠正 14 题、退步 5 题，净增 9 题。uniform 相对异构 fixed 纠正 3 题、退步 2 题，净增仅 1 题，不能据此证明同构优于异构。相同图基线同时改变 root/reviewer 的工具能力，也不能把差异全部归因于图结构。

所有组保持 v3.3.1、Ditto 0.1.1。single 和 fixed-full 最终没有整题执行失败；uniform 第一遍一题因 arithmetic 参数 values 数量不足而中断，已按相同 bundle/runtime 续跑成功，保留其他 485 道题（包括错题）和第一次失败用量。最后无未完成题，没有将运行失败直接记为零分。

仍有节点级推理故障：single 15 次、dynamic 26 次、fixed-full 35 次、uniform 26 次，包含返回不完整结果或重复生成后由程序处理的故障。某些长推理持续十几至二十分钟，并发只加速不同题目，不能缩短单条长请求。arithmetic 参数校验目前仍可能中断整题，后续应与 Python 参数错误一样返回可纠正的工具观察；本次未修改冻结运行时或提示词来消除它。

回归检查：新增同构组后 `npm test` 为 97 通过、0 失败、0 跳过。脚本 provider 测试只证明路由与隔离语义。

完整统计：[JSON 结果](math-v8-round2-ablation-results.json)，包括输入、输出、缓存、模型调用数、失败记录与配对计数。原始结果位于各运行目录的 test/summary.json、test/rows、test/task-usage。
