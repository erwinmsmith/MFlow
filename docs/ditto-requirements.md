# Ditto 通用能力需求与发布后验收

2026-09-30 共享 benchmark 接入复核：数据目录、固定划分、外部官方评分器和任务专用提示词
属于应用层。本轮六个文本 benchmark 没有发现新的通用包缺口；评分容器继续由公开 Sandbox
执行。后续 benchmark 工具通过公开 RegisteredTool / Interaction 注册。标准协议逐任务重置、
关闭 prefix/cache 时不要求任意外部资源事务；DITTO-002 仍是分支回滚/提交时的要求，不能作为
所有普通外部工具调用的前置阻塞。GAIA/BFCL/τ³ 交互 adapter 本轮尚未实现。

更新日期：2026-09-26。原审计版本 `0.1.0`；当前安装 **`@codesoul-co/ditto@0.1.1`**。

- npm tarball：`https://registry.npmjs.org/@codesoul-co/ditto/-/ditto-0.1.1.tgz`
- integrity：`sha512-gqZR8bXw5Rdy66frNUNR/y870nHixcm9SccycBJD/8GKysvOrxLO2TxxqveyghwqyDzCIkjxRIiZ8zJ+gjaEBw==`
- Ditto 源码提交：`041562d`，已推送 main，tag `v0.1.1`。
- 本轮用户明确授权修改 Ditto 并发布包。MFlow 使用 registry 安装，未使用 file/link/workspace 依赖、源码导入、私有 dist 路径或 node_modules 补丁。

## 已发布且已接入

| 原需求 | Ditto 0.1.1 公共契约 | MFlow 验收 |
| --- | --- | --- |
| DITTO-001 恢复与版本保护 | checkpointState / restoreState；Graph checkpoint；显式 Loop stateCheckpoint | 配对候选复用前缀，suffix 等价，跨 JSON 恢复，版本/损坏/此前决策变化拒绝 |
| DITTO-002 一致分支 | BranchStore / StateBranch；显式 JSON 命名空间的 snapshot/fork/discard/原子 commit/冲突检测 | agent turn cache；canonical profile+memory+provenance 同次提交；失败不污染 |
| DITTO-003 预算与用量 | TokenBudget / budgetedProvider；同步 admission；usage settlement；unknown；scope | search/episode 双额度；并发 admission 测试；缺失 usage 非零收费；逻辑/实际成本分离 |

这些契约没有把 spawn、MIA 或 benchmark 逻辑放进包。Ditto 仍只提供通用 Runtime 能力。现有 Worker、Graph、Context、Infer、Interaction、MEMORY CRUD 和纯算术工具流程继续使用公开 API。

## DITTO-001：已满足显式状态恢复；generator 不支持

Graph 在全部在途 Node 结束后保存 checkpoint，恢复跳过已完成 Node。失败的在途操作标记 uncertain，拒绝自动 replay；显式 Loop 记录 state 和下一轮索引。generator/closure/live resource 不可序列化时明确拒绝。

MFlow 在组织决策边界持有完整可序列化状态，模型/工具调用已结束，因而使用公开的 state checkpoint 足够。不会把 deep copy 或重建 Runtime 宣称为对任意 Worker 的暂停和恢复。

## DITTO-002：显式状态已满足，外部资源适配器仍需包支持

**仍缺少的通用能力**：可发现的资源 snapshot/fork capability、opaque versioned handle、统一 scope 绑定与 close/dispose，以及远端适配器的冲突/commit 协议。BranchStore 的字符串命名空间本身不代表 Redis、SQL、文件系统或工具进程已经隔离。

**复现**：为 Interaction 注册一个写真实文件或远端数据库的工具。在 StateBranch 中运行它后 discard，外部写入仍存在。把它的返回值存成 JSON 不能回滚外部状态。

**建议通用契约**：

1. ResourceAdapter 声明支持 snapshot/fork/commit/discard 中哪些能力及是否具有外部副作用。
2. 导出带类型、版本、资源 ownership 的 SnapshotRef，并将 fork 后的 Context/Memory/artifact/tool-session 资源绑定同一 scope。
3. 适配器实现独立写集合和冲突检测；不支持原子提交时明确拒绝需要原子性的组合，不能部分提交后报告成功。
4. 每个 scope 有明确 dispose；不可回滚服务（如发送邮件）明确标记 unsupported。

**验收**：父 memory K=v1；A 写 v2、创建临时文件；B 仍读 v1且不见 A 文件；discard A 清理其资源；commit B 原子可见。版本冲突、资源中途故障和不可回滚工具都 fail closed。

**MFlow 当前边界**：搜索、prefix/cache、continual commit 仅支持显式状态与内置纯 arithmetic。未知工具被拒绝；不在应用里复制远端事务基础设施。接入浏览器、仓库修改、持久进程、文件工具前需完成这一项并重新发布 Ditto。

## DITTO-003：预算账本已满足，provider 物理上界仍需显式保证

TokenBudget 可以严格控制**预留额度**，但无法自行知道任意 provider 的真实输入、协议和隐藏 reasoning token 上界。通用 HTTP provider 目前没有机器可检查的这种保证。Usage 缺失时只能给出 unknown 的保守 charge。

**当前实现**：MFlow 默认按完整请求 UTF-8 字节数 + maxOutputTokens + 1024 估计，支持构造 MeteredProvider 时注入 estimator；超出 reservation 停止实验。未经 provider 契约验证时不声称物理硬 token 上限。

**建议通用契约**：ModelProvider 可公开 usageGuarantee、完整请求 estimateUpperBound/ tokenizer、输出与 reasoning 上限语义，以及失败/取消时已知用量。Budget 可据能力声明拒绝 strict 模式；估计值与承诺上界须区分。

**验收**：含工具 schema、非 ASCII 内容、隐藏 reasoning 的请求在 admission 前得到可验证完整上界；无法保证时 strict 模式明确拒绝；失败和重试的账本不丢已知消费；多进程必须使用同一授权账本。

## 后续接入约束

外部资源与 provider 保证完成后：先发布新包 → MFlow 更新 registry lockfile → public API 验收 → 启用对应实验。继续禁止源码依赖、私有模块和 vendoring。现已启动 DeepSeek Flash 的单 seed MATH 实验；脚本 provider 测试只证明执行协议，多 seed 质量结论尚未建立。

## DITTO-004：长请求流式进度与取消后用量（待支持）

2026-09-27 的全量基线重跑中，存在十多分钟未完成的模型调用；已记录 request ID、开始时间和任务 scope，但目前发布包的 `ModelProvider.invoke` 只有最终响应，`createHttpProvider` 未提供公开的流式增量/进度事件。进程和连接存活不足以证明生成正在推进。

需要的是通用模型传输能力，适用于任何长回答/工具调用，与 spawn 策略无关：

- 公共 opt-in 流式调用或事件回调，区分已发送、收到响应、内容/工具调用增量、完成；携带 run/request ID、时间和供应商 request ID（若有）。
- 保留最终 `SampleOutput` 兼容接口，正确合并工具参数与输出；增量回调不得泄露 API key，也不得绕过 Sandbox。
- 区分用户取消、连接空闲、总体期限、供应商输出上限。取消时保留已知 usage 和内容完整性标记；无法知道实耗则明确 unknown。
- 可配置空闲检测应以实际传输进度为依据；已发送且结果不确定的付费调用不能静默重试或记为零成本。

验收：用分块 HTTP fixture 验证连续输出、长时间无数据、仅 keep-alive、断流、工具参数分块、最终 usage 与主动取消；每条调用记录唯一且准确，回调异常不使计费记录丢失。真实长请求在最终完成前可看到有效进度，完成后与非流式输出和 usage 一致。

本轮仅记录需求，不在 MFlow 里复制 SSE/流式 Provider。待 Ditto 通过 dev → main 更新并发布新包后，再从 registry 更新 MFlow 并验收。

## 2026-09-28：完整 AFlow 策略搜索的能力复核

搜索控制、策略程序、数据评测和实验恢复属于 MFlow 应用。模型优化、agent 推理与工具调用继续使用 registry 0.1.1 公共导出。

Python 计算无需新增 spawn 专用能力：现有 `RegisteredTool`、Interaction、`Sandbox.run` 和 `createLocalSandboxExecutor` 足以正常注册并执行一次性容器工具。新 adapter 只提供工具 schema 和 Docker 参数；未复制执行器、未使用 Ditto 源码或私有模块。容器不挂载 host 文件、不继承模型凭据、不保留跨调用状态，镜像 ID 写入实验清单。已验证工具执行结果通过 Ditto 返回 agent。

这不满足 DITTO-002 的任意外部资源事务要求，因此 Python 工具不参与 prefix/cache/continual commit。v4 默认关闭这些机制；标准协议逐题重置，可直接使用现有包。DITTO-004 的请求增量进度仍待发布包支持，当前逐请求账本只证明请求已发送/已结算，不能证明长调用正在生成。

## 2026-09-28：异构 MAS 配置与动态能力复核

v5 的可复用 profiles、运行图、父节点上下文、成员能力重配置均是应用的组织策略数据。执行时仍通过公开 Ditto reasoning 和工具配置组装；新建、复用、递归、工具隔离的测试使用 registry 0.1.1。未发现此次功能需要新增通用包能力；既有 DITTO-004（真实长请求增量进度及取消用量）仍未解决，不在应用内复制 Provider。

## 2026-09-28 更正：0.1.1 已有公共流式接口

重新核查 registry 安装包与公共导出后，确认 `ModelProvider.stream()` 已存在，提供 `text_delta` 和最终 `result`。此前 DITTO-004 中“没有公开流式接口”的判断不准确。MFlow 现在直接消费该公共接口，记录开始、文本增量计数、最后增量时间、完成或错误；SSE 解码、工具参数组装、网络权限及取消仍由 Ditto 负责。

DITTO-004 尚缺的通用能力缩小为：工具参数/隐藏推理/keep-alive 的分型进度、供应商请求 ID、异常或取消时已知 usage，以及解析失败的具体字段路径。当前工具参数增量不会产生公共 text_delta，不能仅凭没有文本事件判定传输已卡死，也不应用文本空闲计时器终止有效工具生成。

补充复现：供应商返回 `tool_calls[].function.arguments = "null"`，公共 provider 抛出 `INVALID_MODEL_OUTPUT: value must be an object`。即使供应商帧里有 usage，解析失败后公共错误未携带它；应用必须记 unknown，不能以预留值冒充实耗。验收应覆盖上述错误的字段路径和已知 usage 保存。MFlow 未复制解析器或修改 node_modules。

2026-09-30 实际复现：AutomationBench 开发题 `simple.gmail_invoice_email` 的 AFlow 工具调用持续约 15 分钟，公开 text_delta 只观察到 404 个字符，最终抛出工具参数 JSON 未闭合（position 786428），usage 丢失。需要公开参数增量的调用 ID、字节数/最后更新时间，允许应用检测参数生成的精确重复周期，并在解析失败/取消时保留供应商已返回的 usage。验收包含长参数正常完成、参数重复、截断 JSON 与取消；不能把无文本事件视为无进展。当前不复制解析器；模型输出错误按真实世界状态评分，HTTP/基础设施错误仍停止实验。

## DITTO-005：声明式的隔离代码工具创建与任务局部注册（待支持）

核查版本：registry `@codesoul-co/ditto@0.1.1`，2026-09-29。

已有公共能力：`ToolRegistry.register(RegisteredTool)` 可由宿主注册带 `validate/execute` 函数的工具；`INTERACTION.ACT.TOOL` 执行已注册工具；`SandboxExecutor` 执行隔离命令；Graph/Loop/graphStep 已满足原生异构 MAS 编排。此需求不是要求为 spawn 新增专用 API。

缺口：若模型或工作流输出 JSON 形式的代码工具工件（工具名、schema、代码、语言、能力声明），目前没有一个公开、声明式的工件到隔离 RegisteredTool 的构造接口及任务局部注册流程。现有 register 要求宿主可执行 JS handler，不能直接把不受信任工件注册为安全工具。

复现：用公开 `createDitto`、`createInteractionWorker` 和 `ToolRegistry` 建一个任务，在 INFER 节点生成上述工件，随后尝试通过公共节点安全创建该工具，再由下游 ACT.TOOL 调用。当前可执行预装 Python 工具，但无法在不编写额外工具生命周期/工件执行基础设施的条件下完成声明式新工具注册。

期望的通用能力与验收标准：

1. 接受可 JSON 序列化且版本化的代码工具定义，通过指定 SandboxExecutor 执行；不 eval 宿主代码。
2. 创建/注册/撤销可从公开 Graph/Loop 使用，节点名称由 Ditto 设计，不在 MFlow 中虚构。
3. 明确运行范围、命名冲突、权限继承、schema 验证、超时/取消、错误和 usage/event 归属；新工具不能自行提升能力。
4. 不同任务的动态工具隔离，关闭运行后清理；工件可保存与重载，恢复时验证版本。
5. 用一个“生成纯计算工具 -> 调用 -> 观察 -> 撤销”的普通 workflow 验证；无须任何 MAS/spawn 特有概念。
6. 支持版本化工具工件的持久化导出/重载（代码、输入输出 schema、依赖/运行环境摘要、权限与内容哈希），恢复后可由其他 agent 在同一任务中调用；持久化定义与可变执行状态明确分离，不依赖宿主闭包或源码路径。
7. 定义工具工件存储接口、命名冲突/更新规则和可见范围；注册失败、取消、中断重载不得留下半注册工具。由用户配置存储与保留策略，不绑定特定搜索算法或 benchmark。
8. 增加通用验收：“成员 A 生成工具 -> 安全注册 -> 保存 -> 成员 B 调用 -> 重启重载 -> 新任务调用同一不可变定义”，验证结果、版本、权限一致且上个任务的消息和可变内存不泄漏。允许应用冻结选中工具定义供标准 inference 使用，但运行状态应从新任务开始。


MFlow v8 继续使用已有 arithmetic/Python 工具和原生节点。该扩展不阻塞 Graph/Loop 搜索；真正搜索新工具创建流程需 Ditto 按 dev -> main 更新、发布 registry 包后再接入。

## DITTO-006：Context 可关闭的存储规模限制（待支持）

2026-09-29 核查 registry 0.1.1：公开 `createContextWorker({policy})` 可配置 `maxInlineBytes` / `maxItems`，默认分别为 65,536 字节和 256 项；当前校验器仅接受 1..1,000,000 的整数，没有关闭限制的表示。`Infinity`、`null`、`Number.MAX_SAFE_INTEGER` 都不能作为不设限配置使用。

复现：通过公开 createDitto/createContextWorker 创建 runtime，在 CONTEXT.LOAD 中加载超过 64 KiB 的单条消息，默认配置失败；提高到 1,000,000 后超过该值仍失败，不能声明不设存储上限。此限制不等于模型上下文窗口，也不应被当作候选质量差或推进搜索 round。

需求：提供显式关闭 maxInlineBytes/maxItems 的公共配置，或提供透明的 Artifact/reference 存储路径，保证完整内容可以由后续 INFER 使用。两种方案均需要明确定义序列化、原始消息顺序与 metadata、内存/外部存储归属、取消与错误处理。

验收：默认保持兼容；显式不限时，1 MiB 以上的消息及超过默认数量的 ContextItem 不被截断、遗漏或重排；外部模型的上下文限制仍明确报错；应用不需要拆分提示词或复制 Context 实现。MFlow 的优化器已用公开 INFER 直接接收完整消息绕过无必要的 inline 转换，agent 显式使用 Context 的路径仍受包契约约束。
