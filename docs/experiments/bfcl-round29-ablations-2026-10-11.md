# BFCL R29 固定 MAS 对照

用户明确指定 R29（动态 test 426/600，71.00%）；搜索正式选优 R31 仍独立保留。本次属于已观察 test 后指定候选的补充消融，不替换标准协议的最终选优成绩，不把 test 反馈送回搜索。

## 对照定义

R29 从单 root 开始，root 的编排图读取 BFCL 状态，每个公开对话轮次创建新的 `turn_runner`；失败达到原有阈值才调用 root 的 solver 程序恢复。库中仅有 solver、turn_runner 两种角色。

- **固定异构 MAS**：开始时由 root 创建一个固定 `turn_runner`，后续轮次复用此成员。保留 R29 原状态读取、完成判定、40-stage 保护、错误恢复、角色提示词、各自内部图和权限。
- **固定同构 MAS**：同一固定两成员结构；两者统一使用 R29 solver 内部图、node 权限、工具权限和 reasoning 配置。保留各自任务目标和角色指令。

BFCL 是有状态多轮任务，固定的是成员及交互关系，仍按公开轮次循环。root 通常执行确定性状态协调，只有恢复时执行 solver 模型图；不强迫两个角色对所有轮次重复写操作。因此本消融主要对比固定执行者的内部图与动态创建执行者，不能解释为两个 LLM 每轮都协作的实验。

## 公平性与开销

- 同一 `bfcl-multiturn-family-v1` 的 600 条 test；核对任务 ID、内容哈希及搜索/测试不相交。
- 沿用 R29 DeepSeek Flash、temperature=0、seed=42、thinking disabled、冻结 Ditto 0.1.2 执行器及相同已记录的运行修复。
- 两组各 8 路任务并发；无需 Docker。证据压缩存储，保留任务结果、工具轨迹、重试及 usage。
- 独立 test 输出和 token 账本，不计入搜索开销；汇总使用 M token。`knownTokens` 是供应商已返回的用量，`unknownCalls` 单独列出，不能将含预留估算的 `chargedTokens` 当作精确消耗。
- 这是从 R29 派生的固定结构消融，未重新搜索固定图，也未修改搜出的子 agent 程序以适应 test。

## 复现

运行 `npm run build` 后，通过 `scripts/prepare_ablations.mjs --source <R29 bundle> --out <new directory> --variant fixed-bfcl-heterogeneous`（或 `fixed-bfcl-homogeneous`）生成冻结 bundle。构建器严格匹配 R29 的按轮次分配结构，不支持时拒绝修改。

使用同一冻结 actor 的 `dist/src/cli.js evaluate --benchmark bfcl --protocol standard --bundle <bundle> --out <new output> --concurrency 8`，存在 manifest 时加 `--resume`。数据、环境及启动/运行收据位于实验目录，不提交凭据或结果到源码仓库。当前入口为 `runs/current-experiments.json` 的 `localDeepSeek.bfclMFlowR29Ablations`。

## 冻结修复加载与启动核验

旧 `tool-history-20261010/install.mjs` 仅在命令参数含 `/runs/bfcl/MFlow/` 时加载。此次最终输出采用 `<variant>/runs/bfcl/MFlow/test`，日志必须同时确认 tool-history 和 storage 两个修复。另用同一冻结执行器、两个实际 bundle 和无付费的三轮 fixture 验证：只创建一个固定子 agent、连续复用三轮、异构输入包含 turn_runner 专属 Assigned turn 指令，同构输入使用 solver 程序。两者图名相同，不能仅靠图名判定程序相同。

首次启动未匹配该修复路径，已停止并单列为无效试跑，保留全部账本，不混入最终 test。已返回用量为异构 14.502283M、同构 15.438960M，另有异构 3 次未返回准确用量；这属于额外启动开销。详见实验目录 `invalid-startup-pilot.json`。
