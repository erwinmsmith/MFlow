# v5：联合搜索异构 MAS 配置与动态组织策略

## 修复的缺口

v4 每题的 execution.json 已保存实际 agent profiles、outputs、edges 和逐步 state。缺失的是这些配置和运行图进入父节点扩展、候选继承及最终导出的完整链路：候选仅有 program/prompts，冻结 pool 始终为 root；优化器主要看答案失败日志。

v5 候选是完整的 `{organization, program, prompts}`。organization.initialAgents 包含 root 与可选的异构可复用成员，每个成员保存 capability、objective、private_context、tools、reasoning、expected_output、stop_condition。成员数量和职责由搜索提出，不预置角色目录。root 开始工作，其余成员初始休眠。

- 父节点被选中后：加载其完整候选，以及五次验证形成的组织统计和代表执行图；子节点完整继承配置并作局部修改。
- `parent_context.json` 记录父节点编号、完整配置与执行证据，可检查子节点究竟基于什么做了修改。
- 每个 pass 的 `organizations.json` 保留所有任务的组织证据；原始逐题 execution 文件仍保留全部轨迹、输出、配置和图。
- 每轮 `organization_N.json` 统计真实动作、空操作、未送达证据和派生覆盖率；按执行路径/结果保留最多六种代表图供优化器读取。摘要只影响提示长度，不减少全量验证或继承未执行的成绩。
- 冻结时 `best.json` 的 strategy 和 pool 保留所选配置；另导出 `organization.json` 供检查。推理实际使用这些配置。

## 动态能力与执行图

policy 可以检查每个 agent 的 profile、状态、分配、输出、证据与边。

- `DERIVE` 不带 profile：通过 Ditto 执行开放式 Factory，按当前任务和缺口生成能力。
- `DERIVE` 带 profile：直接采用搜索指定的完整能力配置（除 id），由 Ditto 组装和执行；工厂不覆盖该配置。
- `RECONFIGURE`：保留 agent 身份、历史与分配，更新能力、职责、工具和推理模式；下一次执行使用新配置。
- `REACTIVATE` 可指定休眠成员，复用它的不同能力；支持嵌套派生、证据向 owner 路由、消费和失活。
- `CONNECT → CONTINUE` 才能把 child 的证据送达并用于 owner 求解。提示明确指出 ACTIVE 有证据但未送达时，反复执行 owner 不会获得该证据。
- CONTINUE / REVIEW 未写 agentId 时真正默认 root，修复旧接口说明与实现不一致。

可复用 MAS 由成员配置及动态控制程序共同定义。具体任务中的 agent 配置、边和状态变化保存在轨迹中；它们作为父节点优化证据，不自动变成跨任务的解题记忆。标准 test 每题重置，test 不参与搜索。continual 仍通过独立显式协议维护 canonical population。

## 性能与实验边界

此前的成绩差距不能仅归因于少搜索几轮，也不能保证本修复会追平 AFlow。v5 初始 root 公开提供 arithmetic / Python 并使用 react；原 v4 root 默认无工具，因此 v5 必须独立重评，不能继承旧分数。MATH 仍是 AFlow 的 119 validate / 486 test；DeepSeek Flash；每候选五次完整验证；原生 AFlow 父代选择、经验和收敛控制，不使用 racing/MIA/缓存或固定总轮数。

HTTP 服务故障或无效供应商 JSON 会中断搜索并保留断点，不再大量写入零分并进入排名。供应商输出上限等已完成终态仍与服务不可用区分。日志中的未知 usage 预留值不是实测 token 消费。

所有模型推理、工具执行与 reasoning 继续使用 registry `@codesoul-co/ditto@0.1.1` 的公共导出。组织图、成员配置和统计搜索属于应用，无须为这次修复导入 Ditto 源码或增加 spawn 专属运行时。
