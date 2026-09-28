# v4：用官方 AFlow 搜索完整组织策略

2026-09-28。替代默认 v3 搜索，历史结果不覆盖。

## 搜索控制来自哪里

固定 `FoundationAgents/AFlow@3f457218fc716093fe53f6df8a5d5e6379d66346`，`baselines/sources.lock.json` 校验文件哈希。
`scripts/aflow_strategy.py` 直接导入官方 `Optimizer`，复用它的：

- `optimize` / `_optimize_graph`：初始节点评测后，逐次调用原生迭代，直到官方收敛检测通过；默认不设总迭代上限。
- `DataUtils`：历史重复分数取均值、top-4 父节点候选、指数权重与 0.3 均匀探索的混合采样。
- `ExperienceUtils`：父节点的成功/失败修改、相同修改去重、结果回写。
- `GraphUtils` 优化提示词模板：完整产物、单处修改、最多五行代码变化的指导、最多三个失败日志样例。
- `EvaluationUtils`：完整重复评测、逐次成绩记录。
- `ConvergenceUtils`：top-3 均值、z=0、连续五次稳定的原生停止判断。

没有在 TypeScript 里重新实现一套“近似 AFlow”的父节点选择或收敛算法。表示适配层将 Python graph/prompt 文件换成策略 JSON；模型调用换成 Ditto；评测端调用 MFlow runtime 和相同 grader。表示适配所需的提示词修改是公开的，不声称 prompt 逐字相同。

官方构造器默认 validation_rounds=5，官方 CLI 默认 1。本配置**显式选择 5**；当前旧 baseline 为 1，应报告重复次数和实耗，不能称为等计算预算对比。可通过配置选择 1 来复现相同搜索重复配置。

## 去掉的简化

默认路径不调用 `mutations`、MIA 后验/acquisition、affected-set、前缀缓存、agent cache、progressive racing 或均分时低成本晋升。每个候选、每次重复都运行完整 validate，包括明显较差的候选。

模型输出完整 `program`、五类 `prompts` 和 `modification`。程序可以使用条件、循环、函数和数组处理，读取原题、agent 状态、deficit、输出、artifact、边、tool events。它返回下一步组织操作，`DERIVE.request` 可以指定新的开放语义任务。因而搜索的是可跨题使用的策略，执行时才形成不同的 agent graph。

执行提示词包括 agent、factory、review、integrate、retrieve。Factory 仍由 Ditto 执行，动态产生 objective/capability/context/tools/reasoning。程序没有模型调用、网络或文件接口；模型与工具执行仍由 Ditto 的公共 Worker/Graph API 负责。

无新增实验 token、步数、agent 数、深度上限。兼容原有数值类型时使用 `Number.MAX_SAFE_INTEGER` 表示不施加实验限额。供应商 max_output=393216 与 Node 可支持的最长请求期限保留。策略函数的 100ms 同步执行保护用于识别无限控制循环；Python 单次运行保留官方 Programmer 同量级的 30s 执行期限。

## 工具与包边界

`RegisteredTool` + `createInteractionWorker` + `Sandbox.run` + `createLocalSandboxExecutor` 均来自 registry Ditto 0.1.1。Python adapter 只配置 Docker 参数、输入输出与工具 schema，没有复制模型/工具执行器。

每次 Python 调用使用全新容器，无网络、主机文件挂载、宿主凭据或持续状态，模型代码通过参数进入容器。镜像 ID 随 bundle 冻结。默认 Python 3.12 标准库，不宣称与 AFlow 本机 Python 的所有第三方库一致；自定义镜像通过 `MFLOW_PYTHON_IMAGE` 配置，必须重新建立独立实验。

Python 工具的组合、执行与观察回传已经有真实容器测试。脚本 ModelProvider 只验证协议，不代表质量结果。

## 运行与恢复

复用 `../MFlow-baselines/sources/AFlow` 和 `../MFlow-baselines/.venv-aflow`；其他安装位置通过 `--source`、`--python` 指定。首次准备可按 `docs/baseline-rerun.md` 固定源码和依赖；拒绝未匹配 lock 的源码。Node 24、npm、MATH grader 和本地 Docker 镜像也必须可用。

```sh
npm run build
MFLOW_BENCH_PYTHON=.benchmark-venv/bin/python npm run mflow -- search \
  --search data/benchmarks/math/search.jsonl \
  --config configs/aflow-search.json \
  --out runs/math-aflow-v4 \
  --test data/benchmarks/math/test.jsonl
```

默认题目并发 50，每题拥有独立 Ditto provider、账本和组织状态。`--resume` 只跳过同一候选、同一次重复中已提交的题目；跨候选/重复始终重跑。恢复保留已结算成本以及中断在途调用的 unknown 预留成本。完整候选比较与选择只使用 validate；可选 test 参数直到冻结选择后才会被打开。

运行过程保存每次调用的预留与结算、任务尝试、完整 execution、候选/重复结果、优化模型提案和控制器随机状态。更改源码、配置、评分器、数据或镜像会拒绝恢复到同一目录。官方候选格式/加载错误按原生轮次错误逻辑记录并跳过；任务执行按官方 MATH 五次尝试、间隔一秒的设置执行，最终失败计零分并保留成本。

旧 v2/v3 的 `executionVersion` 与 v4 不兼容；复现旧实验必须使用各自的 frozen-dist，不使用新的解释器读取旧 bundle。

## 收敛停止（2026-09-28 更新）

`maxRounds` 默认及本轮配置改为 `null`。适配器每次调用官方 `optimize` 完成一个优化迭代，再依据官方 `ConvergenceUtils.check_convergence(top_k=3)` 判断是否继续；不改变父节点采样、优化提示词、全量评测或经验更新。

官方 z=0、consecutive_rounds=5 表示历史最佳三个策略的平均验证准确率连续五次比较不变；任何 top-3 均值变化都会重新累计。不是“准确率必须超过某个值”，也不保证全局最优。test 从不参与停止或选择。

如候选在多次重复评测中途被中断，必须先补完该候选，不能拿部分重复结果宣布收敛。结束原因保存为 `converged` 或显式配置的 `max_rounds`。模型/基础设施故障仍按故障处理，不能冒充收敛。

## 策略接口校验（2026-09-28 修复）

一次真实提案返回完整箭头函数，旧检查器仅检查语法，错误地将其当函数体执行，造成重复的 undefined 错误。已补充完整函数到函数体的等价规范化，以及不含 benchmark 题目/标签的接口样例检查（返回对象、合法动作、有效引用、DERIVE.request 的专属参数契约）。接口检查不选择更优动作，不按样例正确率筛选策略。

接口不合法的提案先由优化模型修复契约，保留原优化意图；仍失败则按官方候选加载错误跳过，不产生虚假的零分。正式运行中出现未覆盖的策略契约错误时，停止调度更多题目、等已在途任务结束后报错，且删除该候选在官方评分表中的部分重复记录；原始日志和成本保留。普通模型异常仍沿用原来的五次尝试。
