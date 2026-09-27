# 官方基线完整重跑（2026-09-27）

用户要求修复问题后完整重跑，并明确取消原 30M 总额度。当前协议为 `baselines/protocol.json`，新目录为 `runs/baselines-math-unrestricted-20260927/`。旧目录 `runs/baselines-math/` 及其消耗完整保留，不混入本轮结果。

## 执行配置

- 继续使用发布包 `@codesoul-co/ditto@0.1.1`、DeepSeek Flash、temperature 0、thinking disabled。
- 保留同一 AFlow MATH validate 119 / test 486 的成员、顺序及同一评分器。每个方法从头跑完整 test；AFlow 先完整搜索再冻结、测试。
- 移除基线单题 24000、搜索 2280742、所有实验共用 30M 的 token 上限，以及额外 90 秒模型超时。
- Ditto 的 HTTP provider 和 inference worker 默认 30 秒截止时间也通过公开配置调到支持的最大值 2147483647 毫秒；早先因此中断的调用保留未知 usage 标记，失败题恢复执行。
- 移除人为 4096 输出截断，采用供应商允许的最大输出 393216 tokens；仍受真实 API 上下文/输出边界约束。[DeepSeek API 文档](https://api-docs.deepseek.com/api/create-chat-completion/)
- AFlow 调用官方 `Optimizer.optimize('Graph')`，恢复入口默认的最多 20 轮、收敛检测、每轮 1 次完整 validate 和 Custom / ScEnsemble / Programmer 算子。
- DyLAN 保留原生 4 agent、3 轮与共识停止；EvoAgent 保留原生默认 3 次专家迭代；AutoAgents 保留原生团队/管理/执行控制。取消的是外加资源限制，原算法的停止规则继续保留。
- 全部调用记录 usage，不因预算提前返回中间答案。遇到供应商真正的长度上限会明确报未完成，不能伪装完整输出。

## 修复内容

### AFlow

- 累计成本转成 Python float，修复 NumPy 整数写入原生 JSON 记录失败。
- 图评估前检查 Python 语法与 `prompt_custom.*` 引用。旧候选把整个 `SOLVE_PROMPT` 定义生成为注释；对完整注释的合法 Python 定义做确定性还原。
- 确定性还原无法解决时，以语法/缺失变量错误请求格式修复；保留原算法与 modification，不使用 test 标签，不重新设计求解策略。所有修复记入 `AFlow/repairs.jsonl`。
- 首轮工作区从锁定上游版本恢复，旧搜索图已归档，避免复用受限实验的候选。

### AutoAgents

- 角色 JSON 只从 Selected/Created Roles List 读取；不再把数学题或提示词中的花括号当角色。
- 采用 JSON decoder 处理字符串中的嵌套花括号；修复官方示例中的双重花括号与尾逗号。无法解析时仅修复角色/计划序列化。
- 使用结构化角色字段重建供原生环境消费的章节，修复结构化结果已恢复、但环境仍解析原始错误文本的问题。
- 检查执行计划中的每个角色是否有完整定义；后续管理回合若省略了仍被计划引用的角色，从该题的先前角色草稿恢复定义，再进入原生调度。此修复不读取标准答案，不增加计划之外的角色。
- 调度时统一角色名中的空格、下划线与大小写，避免计划中的角色被静默漏调度。移除历史固定 30 秒请求间隔。
- 校验时优先匹配完整角色名，避免把 `Computation and Counting Expert` 中的 `and` 误当多个角色的分隔符。
- 恢复原生 SearchAndSummarize 工具；原生 CUSTOM_ENGINE 无需 SerpAPI 凭据，相关 guard 补丁保存在 `baselines/patches/autoagents-custom-search.patch`。

## 搜索使用 Ditto 发布包

调用链：AutoAgents 原生 SearchAndSummarize → 官方 CUSTOM_ENGINE 接口 → 本地桥 → Ditto `INTERACTION.ACT.TOOL` → 公共 `createWebSearchTool` → 应用注入的 DuckDuckGo provider。

Ditto 发布包已经提供 provider-neutral 搜索接口，其内置 Brave provider 需要 key；当前未配置 Brave key，因此使用免 key 的 ddgs 适配器。这里只适配搜索服务的传输与返回格式，没有复制 Ditto Worker、工具调度或权限实现，也没有导入 Ditto 源码或私有模块。[ddgs 项目](https://github.com/deedy5/ddgs)

搜索请求和结果单独写入 `search.jsonl`；超过 Ditto 工具原生查询格式长度时，使用计费模型将请求压缩为查询。AutoAgents 的检索结果仍由其原生 summarizer 处理。

AutoAgents 首次完整启动暴露了上述角色定义遗漏；首批记录已隔离到 `AutoAgents/test-before-role-consistency-fix/`，修复后从第 1 题重跑。旧尝试消耗仍记入账本，因此报告 token 成本包括故障与修复开销。

## 复现与记录

上游版本与必要补丁在 `baselines/sources.lock.json`；安装方法见[旧协议文档的环境章节](baseline-comparison.md#环境与执行)，执行配置以本文和 `protocol.json` 为准。两个 Python 环境分别安装对应 `requirements-*.txt`。不得在旧源码工作区有运行进程时重置生成图。

```sh
node baselines/bridge.mjs
# 分别运行以下四个进程：
../MFlow-baselines/.venv-aflow/bin/python baselines/aflow.py --phase search-test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py DyLAN --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py EvoAgent --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py AutoAgents --phase test
```

每次正式运行锁定源文件、依赖、数据和评分器。`requests.jsonl` 在发出请求前记 request ID；`usage.jsonl` 记录完成后的实际 usage，未知 usage 单独标记并保守估计，不能混同精确实耗。崩溃恢复时可对账无终态的 request ID。网页搜索不计模型 tokens，其摘要与查询压缩模型调用仍计费。

已验证：6 项离线适配检查；原工程测试 39 通过、2 跳过、0 失败；四种方法验证集试跑均完成；真实联网通过 Ditto 工具返回结果，并通过原生 AutoAgents SearchAndSummarize 链路。试跑用于功能检查，不作为性能结论。

这轮与 MFlow 的固定 24k 单题预算、工具条件不同，应报告为**取消额外限制的基线对比**，同时报告成本与失败率，不能标成计算预算完全匹配的实验。
