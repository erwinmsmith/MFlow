# 多结构初始化与动态工具搜索（2026-10-03）

本次是新的执行/搜索语义；使用 registry `@codesoul-co/ditto@0.1.2`，不需要修改 Ditto。
正在运行的冻结快照保持原协议，不能将新根节点插入旧搜索后继续沿用其 manifest。
HLE 已按用户要求暂停，保留断点；此更新不启动新付费实验。

## 初始化与后续变异

AutomationBench/HLE 的默认根节点从五种扩为八种：

| 名称 | 初始组织与交互 |
| --- | --- |
| single | 单成员按任务使用工具 |
| review | 执行后独立检查、修正 |
| plan-execute | 先分解依赖，再执行 |
| parallel-plan | 两个互补规划分支并行，汇合到执行者 |
| adaptive | 根据题目生成库外成员的 profile 与内部 graph/loop |
| tree | 按题目决定分支数及叶子数，root → 分支 → 叶子，依赖完成后汇总 |
| cross-review | 两个成员同时提出方案，各自检查另一分支，交叉节点依赖后汇合 |
| tool-factory | 先决定是否生成参数化工具，再通过原生 agent 工具循环执行 |

其他文本 benchmark 同样支持这些根节点；默认以 `default` 保留原始初始化，替代其相同的 `review` 别名，避免重复评估。
`aflow-search` 配置的 `initializations` 可显式选择根节点。
所有根节点按同一搜索集和验证次数评估；父节点选择、经验反馈、变异与收敛继续使用原 AFlow 控制器。

规划阶段使用独立控制提示词，执行阶段保留各 benchmark 的原始输出契约。
AutomationBench 的初始树/并行规划成员不做写入，执行者完成真实 API 副作用与后置检查。
这些只是可修改的初始化，搜索可改分支、边、角色能力、成员内部节点、循环与派生条件；
串行不是强制结构，树的层数也不是整个搜索空间的上限。

## 工具定义与执行

- `organization.toolLibrary`：候选继承和冻结的有序工具定义；依赖只能指向已启用的基础工具或此前的定义。
- `ctx.registerTool(agentId, definition)`：当前题内注册，并将名称授予创建者。可用 `ctx.reconfigure` 或 `ctx.spawn` 将该工具授予另一成员。
- `ctx.tools`：本题工具定义、内容哈希、来源与创建者。执行记录在 `orchestration.tools` 中保留同样证据。
- 定义具有 `name`（`generated_` 前缀）、`description`、`parameters`、`implementation`。参数声明 `name/description/type/required`，支持 string、number、integer、boolean、array、object；后两者内容为 JSON。
- Python 定义提供 `def run(args)` 并返回 JSON 值，委托已有 `python` 工具在同一受保护容器内执行。不开放网络、宿主文件或跨调用状态。
- Sequence 定义提供 `steps:[{tool,arguments}]`。参数中的 `{"$input":"/x"}` 读取输入，`{"$step":"/0/result"}` 读取此前步骤结果的 JSON Pointer。返回最后一步结果，失败立即停止，不自动重放写入。

注册和每层调用均经过公开 `ToolRegistry.register/call`，模型选择与观察经过原生 INFER/INTERACTION；
MFlow 仅定义搜索语法与依赖组合，不实现新的模型、容器或工具执行器。
重复名称、前向依赖、循环、未知能力被拒绝；创建者必须拥有依赖能力。
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
