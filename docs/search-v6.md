# MFlow v6：搜索原生 Ditto Graph / Loop 编排

> 当前正式入口为 [v7 联合搜索](search-v7.md)，在本版原生编排基础上增加 agent 模板库的搜索、继承与冻结。

v5 的 `program(state) -> Decision` 主要控制外部组织动作，agent 内部执行路径固定，无法表达用户要求的异构内部 graph 与跨 agent 节点交织。v6 的正式搜索入口已换成完整原生编排。v1–v5 实现保留用于历史测试与结果解释，不用于新的正式搜索。

## 一个搜索节点保存什么

- `composition`：完整 JavaScript 编排源码，定义各 agent 的 graph builder、独立或嵌套 generator loop、跨 agent 数据绑定、动态派生/配置/停止条件；最后返回 Ditto `loop({id, plan: function* (ctx) {...}})`。
- `organization.initialAgents`：异构初始成员。每个 profile 显式声明 `nodes` 与 `tools`，以及能力、目标、推理偏好等。内部图由 composition 定义，不由统一 agent 模板隐式决定。
- `prompts`：完整可编辑提示词。
- 父节点的以上完整工件、真实 node / graph / lifecycle 执行证据，以及官方 AFlow 的经验与分数。

生成 child 时保留整个父编排，进行一次有依据的修改。它可以修改特定 agent 的 node 类型、连接、推理策略、loop，也可以修改跨 agent 控制与数据流，或派生触发与新成员构造。动态策略在执行过程中读取实际输出，决定下一张图及其成员；生成的图既可包含一个 agent，也可同时包含多个 agent 的节点。

## 执行归属

`src/composition.ts` 将候选返回的图计划交给 registry `@codesoul-co/ditto@0.1.1` 的 `runtime.loop`。每一步是公开 `graphStep`，每张图是公开 `graph().node(...)`。Ditto 负责依赖调度、图内并发、INFER 推理、INTERACTION 工具执行和 sandbox 权限。应用只负责候选表示、profile 权限、任务局部成员状态、搜索与结果记录。

应用重建相同拓扑的图以检查节点权限、记录实际绑定和限制同步 JS 执行时间；没有实现另一个图调度器或 reasoning engine。250ms VM deadline 只限制候选同步代码，不限制模型响应时间。VM 不是运行敌对代码的 OS 隔离边界。

当前配置的能力：

| 能力 | 可用节点/策略 |
| --- | --- |
| 上下文 | CONTEXT.LOAD / SELECT / UPDATE / COMPRESS |
| 单次推理 | INFER.REASONING.SAMPLE |
| 推理过程 | TRAJECTORY，策略由 Ditto 执行：cot、long-cot、tot、got、self-consistency |
| 反思 | REFLECT，critique / verify / revise |
| 多结果综合 | DELIBERATE，select / merge / consensus / debate |
| 工具 | INTERACTION.ACT.TOOL -> OBSERVE；arithmetic、隔离 Python |

例如 root 可以是 `LOAD -> SAMPLE`，checker 仅有 `REFLECT`，solver 使用 `TRAJECTORY(tot)`，calculator 使用 `SAMPLE -> ACT.TOOL -> OBSERVE -> SAMPLE`。它们可以出现在同一张图，通过依赖传递结果，也可以让多个 agent generator 轮流 yield 各自的 graph，保留独立 loop 状态。

`ctx.spawn` 创建任务局部 profile；新 agent 下一步的图仍由候选代码构造。需要模型设计能力时，候选先 yield 一个 Ditto INFER 图，再解析 profile 并 spawn。`ctx.reconfigure` 改变后续节点/工具能力；`ctx.dormant` 记录停用。图节点执行时激活其所属成员。节点 ID 必须为 `agentId/localName`，并通过该成员的 `nodes`、`tools` 权限检查。

ToolRegistry 支持宿主注册普通工具，但发布包没有模型生成工具代码的声明式创建节点。本版不会虚构 CREATE_TOOL；Python 代码可通过已配置的隔离工具执行。通用代码工具创建需求见 DITTO-005。

## 实际反馈与复现

每题 `execution.orchestration` 保存：

- 每张实际图的 node 类型、所属成员和依赖；
- 实际 node 输入绑定与输出（包括跨 agent 证据）；
- INITIAL / SPAWN / RECONFIGURE / ACTIVATE / DORMANT / PUBLISH 事件及当时 profile；
- 工具 observation、实际调用与账本用量。

搜索摘要提供节点调用次数、执行过的成员、派生次数、图拓扑和代表性轨迹；完整记录保存在题级文件中，避免把所有模型长输出重复塞进优化 prompt。编排源码本身包含后续图与路由的构造方法。父题的临时状态只作为优化反馈，不作为下一题的运行状态。

AFlow 官方父节点采样、经验处理、5 次完整验证与收敛检测保留。验证为119题，test为486题。搜索无固定 round 上限；推理只在选择冻结之后运行。语义变化后必须建立独立 v6 run，不能复用 v5 的候选分数或未完成评估。逐题断点恢复仍可用，generator 中间状态恢复没有假装支持。

## 验证

`test/composition.test.ts` 使用公开 Ditto + 脚本 Provider 验证真实工具节点、异构图交织、反思结果回流、独立 generator 交替、图内并发、权限拒绝、标签隔离、任务重置及冻结工件复载。`test/aflow-native.test.ts` 验证完整 composition 的父子继承、全量重复、官方收敛、断点恢复与故障处理。这些 fixture 只验证实现，不证明真实 benchmark 提升。

## 运行限额（2026-09-29 确认）

用户确认：取消实验额度与 Context 人为限制，保留代码执行保护。

- maxRounds=null；总 token、单题 token、组织步数、成员数、深度、工具调用次数不另设实验额度（使用接口可表示的最大整数）。收敛仍按原生 AFlow 控制。
- 优化器完整消息直接送入 Ditto INFER，不受 Context inline 默认值影响，不截断父编排与反馈。
- agent 的 ContextPolicy 使用包允许的最大配置：maxInlineBytes=1,000,000、maxItems=1,000,000；不是额外的模型 token 预算。包还没有真正 unbounded 配置，见 DITTO-006。
- 保留同步编排代码的死循环保护、Python 工具的运行时间和资源隔离、节点/工具权限检查。
- 模型服务的上下文/单次输出硬上限仍适用，不能由 MFlow 取消。
