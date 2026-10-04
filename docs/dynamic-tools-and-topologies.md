# 单根 MAS 结构与动态派生搜索

本次是新的执行/搜索语义；使用 registry `@codesoul-co/ditto@0.1.2`，不需要修改 Ditto。
正在运行的冻结快照保持原协议，不能将新根节点插入旧搜索后继续沿用其 manifest。
HLE 按用户要求暂停并保留断点。用户随后授权启动新版 AutomationBench 搜索：先搜索，冻结最终候选后再 test，取消逐轮 test；历史逐轮结果不用于选取或优化。

## 当前搜索协议（2026-10-05 修正）

MFlow 只有一棵搜索树，round 1 从一个 `root` agent 的 `dynamic-policy` 候选开始。
AutomationBench、HLE 配置和其他 benchmark 的默认搜索入口均使用这一单根方案；
候选验证拒绝多个初始 agent。`agentTemplates` 只是可选程序库，不会预先实例化成员。
旧的七个初始化方案依次占据七轮的实验已停止；这不是当前协议，也不将旧分数移入新搜索。

- **round 1**：评估唯一初始候选；每题从 root 出发，按策略决定是否派生。
- **round 2 起**：使用原 AFlow 的父节点采样、父节点经验、完整变异和重复评估。
  父节点来自已经完成评估的历史候选，可能回到较早节点形成兄弟分支；不是强制线性链。
- **搜索对象**：完整 MAS 程序、动态派生/停止/证据交互规则、各 agent 的节点配置与 graph/loop、
  可复用 subagent 和工具库。新候选继承选中父节点的完整程序及真实执行反馈。
- **多样性**：优化器收到已探索分支的结构摘要；树状拆解、并行合并、交叉上下文、异构推理和工具循环
  是候选变异方向，不是七棵独立树。根据任务和测量反馈选择方向，不强制每题创建 agent 或工具。
- **原生提示词适配**：保留一次一个明确改进点，去掉上游 Python 工作流的五行修改限制和十节点限制，
  允许完整实现对应的 Ditto graph/loop、成员配置与控制代码。
- **重复验证**：当前配置为每个候选同一搜索集的五次独立运行，五次不算五个搜索 round。
- **停止与 test**：沿用 AFlow 原生收敛；全部搜索完成后按完整搜索重复评估的平均成绩冻结最优候选，
  执行同一批完整 test。test 不参与提案、父节点选择或收敛，不逐轮 test。

旧结构生成器保留供历史复现和显式消融；正式 MFlow 搜索只允许一个初始化，且必须仅含 root。
AFlow 基线的冻结运行和已有结果不因 MFlow 协议修正而变化。

## 工具定义与执行

`tool-factory` 已移除：它把一项能力误当成了 MAS 结构。新版搜索的
`organization.toolCreation=true` 对所有初始成员、模板实例、树的叶节点和库外派生成员生效。
每个成员在自身的 SAMPLE → TOOL → OBSERVE 循环中可随时选择 `create_tool({definition})`，
注册成功后下一次推理即可调用新名称；无需额外的强制设计调用，也不设专职创建者。
创建者由 Ditto `WorkerContext.execution.nodeId` 识别，不接受模型伪造身份。
能力只增加注册入口与 TOOL/OBSERVE 节点权限，不统一各成员的推理图或基础工具权限。
规划成员可用 API 发现/纯计算能力创建组合工具，但不授予 AutomationBench 的写入接口。
跨 agent 依赖消费的是工具循环完成后的证据；并行规划与树/交叉图依然保留不同结构。

SingleLLM 的 `seed` 命令明确关闭创建能力，保持直接模型调用 benchmark 原始工具的对照定义。


- `organization.toolLibrary`：候选继承和冻结的有序工具定义；依赖只能指向已启用的基础工具或此前的定义。
- `ctx.registerTool(agentId, definition)`：当前题内注册，并将名称授予创建者。可用 `ctx.reconfigure` 或 `ctx.spawn` 将该工具授予另一成员。
- `ctx.tools`：本题工具定义、内容哈希、来源与创建者。执行记录在 `orchestration.tools` 中保留同样证据。
- 定义具有 `name`（`generated_` 前缀）、`description`、`parameters`、`implementation`。参数声明 `name/description/type/required`，支持 string、number、integer、boolean、array、object；后两者内容为 JSON。
- Python 定义提供 `def run(args)` 并返回 JSON 值，委托已有 `python` 工具在同一受保护容器内执行。不开放网络、宿主文件或跨调用状态。
- Sequence 定义提供 `steps:[{tool,arguments}]`。参数中的 `{"$input":"/x"}` 读取输入，`{"$step":"/0/result"}` 读取此前步骤结果的 JSON Pointer。返回最后一步结果，失败立即停止，不自动重放写入。

注册和每层调用均经过公开 `ToolRegistry.register/call`，模型选择与观察经过原生 INFER/INTERACTION；
MFlow 仅定义搜索语法与依赖组合，不实现新的模型、容器或工具执行器。
重复名称、前向依赖、循环、未知能力及以 create_tool 为依赖的定义被拒绝；创建者必须拥有依赖能力。
每层调用纳入调用保护并传递取消信号，基础沙箱权限不因注册新名称而扩大。

## 搜索、冻结与 inference

优化器可根据 **search** 的工具定义与执行反馈修改工具库、内部 agent 图和 MAS 派生程序。
冻结的 `best.json` 携带完整 organization；`tool-library.json` 提供选中工具库的单独导出，
与 `agent-library.json`、`organization.json` 一起标注所选轮次/策略哈希。

Inference 从冻结定义重新注册工具，运行同一派生程序，仍可生成新的工具或库外成员。
每题单独创建 registry；题内新建工具不会自动进入模板库，不会传给下一题或搜索。
持久化的是源定义，不是题目答案、消息、世界状态或可变工具会话。
任意外部资源的事务/回滚仍属于 `DITTO-002` 未满足部分。

验证覆盖公开 Ditto 调用、模型生成→注册→观察、成员间授权调用、定义重载、题间隔离、
依赖/参数错误、写入前失败、嵌套调用保护、实际 Docker Python，以及树/交织节点并发。
这些工程测试使用脚本模型，只证明执行契约，不证明准确率提升。


## 搜索监控与运行调度

`scripts/automation_experiment.py` 仅在搜索结束后启动最终 test，不自动提交任何逐轮测试。
`--methods MFlow` 可以运行独立的新 MFlow 快照；`--methods AFlow DyLAN EvoAgent AutoAgents`
可在旧快照上恢复其余方法，保持原来的配置、划分和已完成题目。调度策略写入 `scheduler.json`，
不会把调度变化冒充为同一个 actor 版本。远端 Qwen 原调度已经是 final-only。

`--status` 的 `methods.MFlow.currentValidation.organization` 报告：派生题数、生成的成员程序数、
创建的工具数、通过原生 TOOL 节点调用生成工具的次数/成功次数、跨 agent 图依赖边、最大派生深度和节点失败。
这里工具调用成功是运行成功，不代表任务得分提高；复合工具内部的依赖调用不重复计入该指标。
`methods.MFlow.searchCurve` 报告每轮已完成重复数和平均得分，必须等满配置的重复次数才比较完整轮次。
统计仅从已落盘的 search 记录汇总；不额外保存大模型请求全文、世界快照或读取 test 来指导优化。

## 2026-10-04 修正与实验边界

后加的 v6 MFlow 已按用户要求停止。它的工具创建只在专门的初始化中暴露给模型，
不符合各 agent 均可自主创建工具的要求。新版使用新的执行版本与独立搜索目录，
不续接 v6 的分数或父节点。旧快照与结果仅保留追溯；其他 baseline、SingleLLM 保持原协议。
新的搜索仍复用官方 AFlow 的父节点选择、反馈与收敛控制；搜索完成后再做最终 test。
工程测试覆盖七种结构中的实际创建/调用、生成成员和孙节点、错误修复、权限与题间隔离；
是否主动创建有用工具、是否提高得分，需看真实 search 记录，不能由脚本模型测试推出。

## 搜索与 test 共用的 Ditto 设计指南

`src/ditto-guide.ts` 是唯一的版本化契约说明，依据已发布的 Ditto 0.1.2 README 与公开类型整理。
它区分 Worker、node 和 agent，说明本项目实际启用的节点输入/输出、CoT/ToT/GoT/
self-consistency、反思/融合、工具创建与调用、Context 加载/选择/更新/压缩，以及串行、
并行、树状和跨 agent 节点交织的编排方式。公开包中未在当前部署配置的节点不会冒充可用能力。

- 搜索优化器读取同一指南；成员派生通过 `ctx.textMessages(id,evidence,'factory')` 或
  `ctx.messages(...,'factory')` 自动收到完整指南、当前成员、模板和真实工具 schema。
- 自定义派生图可读取 `ctx.dittoGuide.text` 并用于设计提示词；普通解题轮次不重复注入指南。
- 搜索启动保存 `search/ditto-guide.json`，manifest 记录哈希；每轮候选和最终 `best.json`
  保存相同正文、版本、包版本与哈希，执行版本也包含指南哈希。
- `infer`/`evaluate` 在付费执行前检查冻结指南与当前运行时一致；缺失或修改过的 MFlow
  指南会拒绝运行。要升级指南，必须创建独立版本重新搜索，不能混用旧分数和新接口。
- Test 仍可按冻结程序派生库外成员、创建题内工具与动态交互图；题内状态与测试评分
  不会回流到搜索，也不会自动成为下一题的工具库或模板。

## 2026-10-04 运行恢复：内存与磁盘故障

长工具循环的每一张历史图曾用 structuredClone 复制累计消息；不可变字符串也被重复分配，
使长上下文的记录占用随步数接近平方增长。现在只复制可变容器、共享不可变字符串，
保留完整历史内容与隔离性；不删除模型上下文。摘要哈希改为逐块写入 SHA-256，
与原 canonical 字节完全一致，避免再构造一份巨大的序列化字符串。

单独的 96 MiB Node 进程回归覆盖 64 步累计长消息、隔离拷贝与等价哈希。
冻结实验通过带原始/替换文件 SHA-256 的应用层 I/O 修复记录加载；原 actor 文件、
提示词、Ditto 包与数据划分不变，不覆盖已完成题目或修改搜索策略。

原生 baseline 适配器中的 OSError 现在作为基础设施故障退出，不再作为模型失败评分。
已确认因磁盘写满导致中断、却被错误提交的结果单独留存失效记录，再从干净题目世界重试；
正常完成但答错、模型格式错误的记录保留，不能按 test 得分选择性重跑。

## AutomationBench tool creation repair (2026-10-04)

AutomationBench MFlow search now registers the existing isolated Python tool in
addition to the official API tools. Its immutable image ID is saved in the search
manifest and frozen bundle; inference uses that same image. With tool creation
enabled, every initial/spawned/reconfigured agent receives Python when the
deployment provides it. API write capabilities remain heterogeneous. Other
baselines retain their original tool configuration; report this MFlow compute
capability difference in comparisons.

Each create_tool action describes the exact creator, allowed dependency names and
Python availability. Dependency errors name missing and available capabilities.
Discovered API endpoints must be passed to api_fetch, never used as registry names.
This fixes the previous workflow deployment that advertised Python definitions
without providing Python. It does not remove dependency validation.

The updated MFlow experiment starts a new frozen search run because capabilities
and model-visible instructions changed; previous search scores are not reused.

Generated tools are also shared with existing and later-spawned members that
already hold every dependency. Sharing cannot grant API write access to a
read-only planner. This prevents a capable reviewer from seeing a generated
tool in evidence but being unable to use it.

## Dynamic policy search (2026-10-05)

The single policy-first root can design a new graph before acting. All later
candidates start with one agent and evolve the inherited MAS program. Alternative
layouts are branches of the same search tree. AFlow mutates internal programs,
controller prompts and feedback-conditioned derivation jointly.

Each policy decision records stop/continue, rationale and unresolved gap. A
continuation supplies a complete native Ditto graph/loop stage: reuse a member,
spawn a heterogeneous program, reconfigure capabilities, change an existing
program with ctx.bindProgram, or weave multiple members into one dependency graph.
After execution, current profiles, outputs, generated programs and executed
topology are supplied to the next decision. Successful world effects are retained.
Stages return AgentOutput and the complete MAS returns final text. Every model
call and executable node still runs through the published Ditto package.

ctx.structure exposes topology/program/decision evidence without duplicating raw
graph output histories. ctx.recordDecision writes task-local policy evidence; it
is not a grade or correctness signal. ctx.bindProgram changes only future
internal execution, preserving identity and profile. Native INVALID_INPUT feedback
(including malformed REFLECT criteria) returns to the generated program instead
of aborting the entire task before the policy can repair it.

Search feedback covers outcome/topology changes, generated programs, tools,
cross-agent sharing and node failures rather than taking the first six examples.
reusableCandidates contains representative successful program shapes and
successfully invoked tool definitions with provenance. These remain search
evidence, not automatically trusted templates: the optimizer must generalize
away task values, promote useful artifacts explicitly, and re-evaluate the full
candidate. A task passing does not establish a causal benefit for any one tool.

AFlow's parent sampling, experience filtering and convergence test remain in use.
There is one initialization; subsequent rounds are measured mutations. Native
convergence operates on those candidate scores. No maximum search-round or
experiment-token quota is added.

The frozen bundle retains the full initial organization, dynamic control code,
all prompts, reusable library, guide and Python image identity. Search and test
execute the same program; runtime-generated members are fresh for each task and
need not belong to the frozen template library. Test outcomes never enter the
optimizer. The separately user-selected old round 9 test runs in the old v8
snapshot; this changed search starts a fresh independent experiment.
