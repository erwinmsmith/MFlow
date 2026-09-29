# MFlow v7：联合搜索 agent 内部图、模板库和动态 MAS

v7 在 v6 原生 Ditto 编排上增加可继承、可冻结的 agent 模板库。优化对象是完整 MAS：内部图优化和 subagent 复用都属于同一个候选，不替代动态派生策略。每次修改仍走官方 AFlow 的父节点采样、经验反馈、完整验证和收敛判断，没有另建一个简化的模板搜索器。

## 完整候选

| 字段 | 搜索内容 | test 的用途 |
| --- | --- | --- |
| `composition` | MAS 的派生条件、模板选择、任务分配、串行/并发/交织、跨成员图和证据路由、重配置、停用与终止 | 冻结的动态控制程序；根据当前题目的实际中间输出构造执行图 |
| `organization.initialAgents` | 初始成员的能力、节点和工具权限、目标与推理偏好 | 每题重新创建初始成员；它们的 profile 为初始配置的权威来源 |
| `organization.agentTemplates` | 每个模板的能力 profile、独立 graph/loop 源码与用途说明 | 派生时实例化完整 agent；不只是补一段角色提示词 |
| `organization.initialBindings` | 初始成员 ID 到模板 ID 的映射 | 为初始成员绑定内部执行程序；不会覆盖 initialAgents 的 profile |
| `prompts` | agent/factory/review/integrate/retrieve 提示词，另可改各模板 profile.private_context | 与上述结构一起冻结 |

模板格式为 `{id, description, profile, composition}`。模板 profile 不含实例 id，其他字段与普通 agent 一致。模板源码返回公开 Ditto `loop({id, plan:function*(ctx){...}})`，generator 返回 AgentOutput 对象。外层 MAS generator 最终返回答案字符串。内部推理、工具和图调度仍只由发布的 `@codesoul-co/ditto@0.1.1` 执行。

## 运行接口

```javascript
// 外层 MAS 的局部示例，触发条件和路由本身可由搜索修改。
if (unresolvedGap) {
  ctx.spawnTemplate(selectedTemplate, 'child-1', 'root');
  const evidence = yield* ctx.runAgent('child-1', { deficit: unresolvedGap });
  ctx.dormant('child-1');
  const integrated = yield* ctx.runAgent('root', { evidence }, 'integrate');
  return integrated.candidate_answer;
}
```

- `ctx.templates`：当前候选的完整模板库快照，供控制代码或经 Ditto 执行的选择器读取。
- `ctx.spawnTemplate(templateId, newId, parentId='root')`：复制模板 profile，绑定其程序，创建任务局部成员。创建本身不调用模型。
- `yield* ctx.runAgent(id, evidence=[], prompt='agent')`：委托该成员的内部 generator。其 `graphStep` 仍由同一个 Ditto 原生 loop 执行。模板内用 `ctx.self` 命名节点，用 `ctx.evidence` 和 `ctx.prompt` 读取本次输入。
- `ctx.bindTemplate(id, templateId)`：替换成员后续调用的程序及 profile；已经启动的 generator 保留当前程序。
- `ctx.reconfigure(id, profile)`：只调整 profile，不替换内部程序。
- `ctx.spawn(profile,parentId)`、直接构造跨成员 graph、读实际图/输出、停用与重激活等 v6 能力继续保留。

每个模板可以使用不同节点和拓扑，不强制共用一种推理流程。模板可以嵌套委托并派生其他模板。多个 `runAgent` generator 可逐步交替推进；外层编排仍可把不同成员的节点构造成一个带跨成员依赖的 Ditto DAG。前者支持独立内部 loop 的交织，后者支持节点级协作。

单个模板的编译闭包属于本题；每次 runAgent 有自己的 generator 局部状态。复用代码不会继承上一题的消息、答案、图执行状态或派生成员。所有图节点照常检查所属成员的节点/工具权限，嵌套 generator 和绑定函数保留同步死循环保护。

## 初始候选与搜索

初始模板库包含两个可编辑种子：

1. solver：Context → Sample，必要时 Tool → Observe → Sample，提供结果整合能力。
2. verifier：独立 REFLECT 节点，针对具体缺口返回验证 artifact。

初始 MAS 先执行 root；若报告未解决缺口，按缺口派生 verifier，回传结果后由 root 整合。无缺口时可直接完成。这只是可修改的起点，不是固定角色目录、强制派生数量或被隐藏在运行时的策略。搜索可增加、删除、重写模板，改变成员能力和内部图，也可修改外层 MAS 的选择、派生、连接、整合、停止方法。

子候选继承父候选的整个模板库、编排与提示词以及实际执行反馈。一次聚焦修改可以同时修改模板和使用该模板所需的路由；随后以完整候选进行 5 × 119 题验证。没有给单个 subagent 虚构独立质量分数。

反馈保留实际图拓扑、绑定输入/输出、完整 profile 和生命周期，并增加 `RUN_TEMPLATE`、templateId、各模板调用次数、覆盖题数与这些题的正确数。正确数只是使用关联，不能解释为该模板的因果贡献。

## 冻结与 test

选择完成后输出：

- `best.json`：完整推理 bundle，内含策略、模板库、初始组织、模型配置与复现身份。
- `organization.json`：完整 MAS 源码、模板库、初始配置和提示词。
- `agent-library.json`：同一个选中候选的模板库和初始绑定，标明 selectedRound 与 strategyHash，便于检查。

486 道 test 只加载冻结 bundle。动态派生、任务分配和图构造由冻结策略根据当前题目执行，既不重新优化模板，也不汇总失败候选的模板。test 标签不进入模型和搜索。性能改善必须由后续完整验证及最终 test 证明。

## 实验边界

v7 改变初始 MAS 与候选语义，必须使用独立 run，不复用 v6 成绩。保持 MATH 119/486 划分、DeepSeek Flash、完整 AFlow 搜索与收敛。继续取消实验额度，保留代码执行保护和发布包/服务的硬边界；见 v6 文档的运行限额。先前供应商流式响应中断是独立的运行问题，本次模板库更新不宣称解决它。
