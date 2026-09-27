# Ditto 通用能力需求与发布后验收

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

外部资源与 provider 保证完成后：先发布新包 → MFlow 更新 registry lockfile → public API 验收 → 启用对应实验。继续禁止源码依赖、私有模块和 vendoring。当前没有运行真实模型或多 seed benchmark；现有脚本 provider 测试只证明执行协议。
