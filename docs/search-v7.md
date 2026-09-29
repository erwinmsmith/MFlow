# MFlow v7：联合搜索 agent 内部图、模板库和动态 MAS

历史版本记录。当前运行改动见 [v8](search-v8.md)，包括文本推理种子和节点局部故障恢复。

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

## 2026-09-29：工程可靠性与提示词修复

原始 v7 的验证中出现评分子进程退出、REFLECT 输出格式失败以及个别请求达到服务的 393,216 输出 token 上限。超长响应大部分为非空白字符，不能仅凭长度断言其内容重复。旧进程已停止，旧成绩保留；提示词和失败处理语义变更后使用独立 run。

### 评分与生成分离

- 成功的完整 execution 先原子写盘，之后才执行评分。search 和标准 test 都采用这个顺序。
- MATH 评分本地最多同时运行 min(4, CPU 并行度) 个 Python 子进程，避免 50 个模型任务同时触发冷启动竞争；排队不计入子进程保护期限。这不减少模型并发、题数、搜索轮数或实验额度。
- 每次评分子进程保护期限 30 秒，失败最多重评三次，始终使用同一份 gold 与原答案。持续失败明确报 GradingFailure，保存退出信号/错误信息并停止控制器；不会写成答错或重新生成模型答案。
- 断点恢复先加载已经保存的 execution，再评分。仅成功保存的同候选同题执行可复用，manifest 仍校验完整身份。原生生成失败的五次尝试与评分重试分开。
- 从旧日志恢复的 28 个不同失败评分输入，在新路径全部完成评分，未调用模型。旧日志缺少退出信号，因此不能把原故障全部确定归因为 CPU 竞争。

### 验证节点局部恢复

REFLECT 的 INVALID_MODEL_OUTPUT 可作为公开 NodeResult 回到编排 generator。种子 verifier 明确要求 assessment 对象、issues 数组、JSON 转义和结束格式；若输出无效，针对相同 target 局部再执行一次 REFLECT，不重跑 root 或整题。仍失败时发布 verification_error，保留未解决缺口，不能声称验证通过。若没有有效验证 artifact，保留原始 provisional answer。传输异常、不完整响应和其他节点故障仍明确传播。

节点的失败次数/错误类型进入组织反馈，供后续 AFlow 优化图、模板和路由。Ditto 仍负责 REFLECT 的提示构造、解析与 schema 验证；MFlow 未复制包的解析器，也未导入私有模块。

### 长输出与提示词

agent 提示词强调一次给出决定性论证、避免枚举巨大空间和反复重写推导、遇到障碍明确返回缺口，并正确关闭 JSON。字段仍完整，没有截断上下文或降低模型输出上限。JSON 提示词格式参考 [DeepSeek 官方 JSON Output 文档](https://api-docs.deepseek.com/guides/json_mode/)。

消费 Ditto 公共 text_delta 时，检查是否存在持续精确相同的输出周期（至少 8 次且覆盖至少 8192 字符）。检测的是生成停滞模式，不是达到某个总长度；长而不同的内容继续接受。不解析/复制 SSE，不伪造完成响应，取消通过公共 AbortSignal 传递。触发时记 DEGENERATE_OUTPUT 并停止本轮控制器，不静默重新采样，usage 未返回则保留 unknown。失败和达到输出上限时仅保存有限的首尾诊断片段；这不改变送入模型的上下文。

精确重复检查是故障启发式，不能检测所有语义重复，也可能拒绝故意重复的大段内容。停止后应检查诊断记录再恢复，不能把触发次数解释为任务正确率。不同形式的冗长响应仍可能达到供应商硬上限。

### 验证证据与限制

原先发生超长输出的两道验证题，用修复后的同一 Flash 模型回归，分别在约 12 秒、14 秒完成，评分均正确；其中一题出现一次 REFLECT 格式错误，已局部恢复，root 未因格式错误重跑。这两题仅用于故障回归，不计入新候选验证成绩，也不能作为性能提升的统计结论。
