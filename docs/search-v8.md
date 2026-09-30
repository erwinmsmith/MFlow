# MFlow v8：完整文本推理与可恢复的动态 MAS

本版仍联合搜索 MAS 控制程序、各 agent 的内部 graph/loop、能力 profile、模板库和提示词，沿用官方 AFlow 控制器。不是只优化 verifier；角色目录和推理方法不是固定的。搜索可探索分解、不同数学方向、独立推导、反例、计算/枚举工具、跨成员图和递归委托。

## 从实际 AFlow 运行学到的改动

本地 AFlow MATH round 12 的完整验证成绩为 118/119；其代码为一次完整解题，再把原题和完整推导交给第二次推理审查、修正，最终返回第二次输出。它没有让解题调用同时满足 MFlow 的 claims/artifacts/deficits JSON schema。v7-02 的首遍验证为 94/119，第二遍未完成，随后因子节点重复输出退出；不能把这些部分结果解释成搜索多轮后的表现。

v8 以实际 round 12 的解题/复核提示词为可编辑初始提示：

1. root 通过 Ditto Context → Sample 输出完整文本解答。
2. 第二个 agent 接收原题和完整推导并修正；其内部图只有 Sample。
3. 两者最终答案一致时结束；不一致、缺少答案或节点失败时，派生使用另一种方法的独立 agent。该成员拥有 Context/Sample/Tool/Observe 和 arithmetic/Python 能力，开始时不接收前两者答案。
4. 独立结果与已有答案一致时返回；仍有分歧时路由完整推导给整合步骤。所有执行失败均无答案时返回空答案并正常计错。

这是初始候选的控制逻辑，所有模板和路由均可被搜索修改。字符串一致仅用于派生决策，评分仍使用统一 MATH grader；等价但表示不同的答案可能触发额外推理。不能将多数一致等同于数学正确。

完整解答保存为 solution artifact；错误样本反馈携带各成员完整解答，供优化器定位推导错误，不只看到最终答案。`ctx.publishText` 提取最后一个括号完整的 boxed 答案；`ctx.textMessages` 包含实际 profile 的目标、能力、推理方向、输出要求和停止条件。Ditto 的每次调用公开 providerOptions 决定 text/JSON 格式，部署模型和其他供应商选项保持固定。原生 REFLECT/DELIBERATE 的 schema 仍由 Ditto 负责，搜索可以选用这些节点。

## 故障范围

DEGENERATE_OUTPUT、INVALID_MODEL_OUTPUT、INCOMPLETE_MODEL_OUTPUT 和供应商输出上限变成当前节点的错误结果，交回被搜索的编排处理。初始候选会使用另一个 agent，不把截断内容当成有效证据，也不因此重跑 root 或全部任务。网络、HTTP、鉴权等基础设施故障仍终止并保留断点，成功的并发兄弟节点不能清除该故障。

Python 执行失败时，简短退出码放在 Ditto 的 error.message，完整隔离运行诊断放在公开 content 字段，经 OBSERVE 回到原 agent。多段工具观察内容在构造 SAMPLE 请求时序列化为文本，保留所有字段，符合 DeepSeek 的 tool-message 接口；原生观察输出仍完整保存。此前把多行 stderr 放入 error.message 会触发包的安全字段验证并导致整题重试；新增真实容器错误回归覆盖此路径。

复核提示词明确在决定性检查完成后结束，避免反复重算同一个结论。无限循环、代码执行保护、原有精确重复检测继续保留。长而不重复的内容不设应用层输出长度截断；供应商硬上限仍存在。评分失败仍只重评已保存的同一答案。未返回 usage 的调用保持 unknown，执行 actualTokens 为 null，不能把预算预留数当作实耗。

## 实验与可比性

- 新运行从 round 1 重新评分，不复用旧 v7 或诊断题分数。
- MATH 固定 119 题验证，每候选完整重复 5 遍；486 题 test 仅在选定并冻结后打开。
- 继续官方 AFlow 父节点选择、历史经验、失败反馈、完整候选评估与原生收敛；没有增加轮数、token、agent 数量或派生深度额度。
- 父候选的完整组织、模板代码和实际图反馈一起继承；不同模板可有不同节点组合和推理方法。
- **这是使用 AFlow 验证搜索产物的迁移初始化实验**，不是两者完全独立、同等搜索成本的冷启动比较。最终报告必须披露此先验及来源；不能用新 MFlow 自身调用成本代表全部前置搜索成本。AFlow test 未用于改动。
- 工程测试使用脚本 provider，仅证明执行、继承、故障与恢复语义；质量以新完整真实验证和冻结 test 为准。

## 工具创建与持久化边界

目前 arithmetic/Python 执行由 registry Ditto 0.1.1 负责，Python 每次隔离执行。模型可以生成并执行代码，但尚不能通过公开声明式节点创建、注册并持久化一个可跨 agent 复用的新工具。不能将 Python 调用伪称为持久化工具能力。

通用工具工件的定义、隔离注册、版本化保存/重载、权限与生命周期要求记录在 [DITTO-005](ditto-requirements.md#ditto-005声明式的隔离代码工具创建与任务局部注册待支持)。取得新发布包前，此能力明确待支持；MFlow 不从 Ditto 源码导入，也不自建替代工具基础设施。后续接入时，通用工具定义可随选中候选冻结，标准 test 每题仍使用全新执行状态，不能继承其他题的答案或可变运行内存。

## 修复回归

2026-09-29：86 项工程测试通过，0 失败、0 跳过。两道实际触发 HTTP 422 的验证题单独重跑，均完成并评分正确，分别执行 3 次和 2 次工具调用；这些诊断分数不进入新搜索。正式运行仍从空的候选评估目录开始。

## 冻结策略的并发 test

`scripts/evaluate_concurrent.mjs` 只调度独立的标准 test 题目，每题创建独立的 Ditto runtime、provider 和用量账本。`--runtime` 指向选中实验的冻结应用代码目录，保留原 bundle、模型、提示词、MAS 和工具执行方法。调度器不向执行器传入标准答案；答案仅交给冻结的评分器。并发度是运行调度参数，不改变候选策略。

```sh
node --env-file=.env scripts/evaluate_concurrent.mjs \
  --runtime runs/EXPERIMENT/frozen-dist/src \
  --bundle runs/EXPERIMENT/frozen-current-best/best.json \
  --test data/benchmarks/math/test.jsonl \
  --out runs/EXPERIMENT/frozen-current-best/test \
  --concurrency 50 --resume
```

续跑按 task ID 识别已完成结果，保留错误答案，不重复生成；结果可乱序完成，单题基础设施失败记录为未完成，其他题继续，不写成零分。模型执行先保存到 `executions/`，评分结果独立保存到 `rows/`，账本保存到 `task-usage/`，流式进度保存到 `requests/`。`status.json` 给出进度；全量完成才生成 `summary.json`，否则生成 `partial-summary.json`。中断后应使用同一并发入口续跑，旧串行入口要求结果是有序前缀，不能用于并发日志。

从旧串行进程迁移时先停止旧进程，以免重复做题，保存 `serial-usage.json` 和 `serial-interruption.json`。如果旧请求中断前没有可用的 usage，实际总 token 保持未知，不能把已记录用量当成完整实耗。test 结果与派生日志用于报告，不反馈给这一标准实验的搜索。

## 2026-09-30：工具输入、重复响应与连接恢复

Python 的声明式输入 schema 保持严格。工具 handler 在执行入口校验 `code`，非法参数返回 `PYTHON_ARGUMENTS` 的失败 observation，不启动容器。Ditto 0.1.1 的 `RegisteredTool.validate` 抛错会直接中断节点，因此适配器把可由模型纠正的参数错误放入公开 `execute` 的失败结果，仍由 Ditto 执行工具并传递观察。

精确重复检测会检查多个匹配位置，支持最多 8192 字符的周期，要求连续至少八次相同周期，覆盖至少 8192 字符；滚动检查窗口为 128 KiB。这个窗口只用于故障检测，不截断模型请求或答案。不使用数学答案、语义相似度或总响应长度作为终止条件。此前只检查最近匹配位置，短语在长周期内部重复时会漏检。

连接重置、断管、连接超时或异常 `terminated` 最多重试两次，等待分别为 1 和 2 秒。每次重试使用原始请求，单独进行 Ditto TokenBudget 预留、结算和记录；部分文本不拼接到成功结果，未知 usage 不被抹除。鉴权、用户取消、模型格式错误、精确重复故障不自动重试；最终基础设施失败仍保留为未完成。模型、提示词、派生策略、工具权限和代码执行保护保持原配置。

执行版本更新为 `mflow-native-library-v3.3/tool-input-observations-transport-recovery`。固定此前选中的 Round 2 策略，使用新运行时完整重测 486 道 test；旧版 474 道完成记录单独保留，不与新成绩混合。不用 test 的正确答案修改推理提示词、候选结构或重新选择 round。原验证成绩来自旧运行时，报告时应披露这一差异。

## 搜索与 test 隔离审计

2026-09-30 对当前 v8 记录核查：119 道搜索题与 486 道 test 的 ID、规范化题目和组均没有交集，数据文件匹配 AFlow 固定划分哈希；689 条失败反馈全部来自搜索集；搜索请求没有 test task ID，冻结后没有新的搜索调用。冻结 bundle 与选中的 Round 2 完全一致，并发执行代码与搜索冻结代码匹配。策略冻结时间为 04:25:30 UTC，首次 test 为 04:26:00 UTC；执行端仅接收 ID 和题目，标准答案只传入评分器。

上述证据支持“当前 v8 没有发现直接的 test 到搜索数据泄漏”。仍需披露两项实验背景：MFlow 种子借用了 AFlow 在验证集上搜索得到的 Round 12 提示词，因此属于迁移初始化；相同 MATH test 已在历史 v2/v3 实验运行过，不能称为整个项目从未查看过的独立 holdout。后续若参考该 test 成绩改变策略或选择候选，须按开发评测报告，最终独立泛化评估应采用预先留出的新 holdout。基础模型的预训练污染和题目语义近重复不在此次本地数据流审计结论内。
