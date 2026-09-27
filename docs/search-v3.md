# 搜索控制 v3：多轮策略树与可恢复评测

## 与 AFlow 的关系

核对的是固定上游版本 `3f457218fc716093fe53f6df8a5d5e6379d66346` 的 `Optimizer._optimize_graph`、`DataUtils.select_round`、`ExperienceUtils` 和 `ConvergenceUtils`。

AFlow 会从历史高分轮中抽取父节点，读取该节点的 workflow、prompt、错误样本及该父节点下的成功/失败修改，再产生子节点。后续轮可以接续较早的高分节点，并不总是接续上一轮。当前上游 `max_rounds=20` 指 20 次优化迭代；首次迭代还评估初始 round_1，最多形成 round_1 至 round_21。

MFlow v2 已有策略树，MATH 实测路径为 `s0 → s1 → s2 → s4`，另有 `s0 → s3`。不足是实验配置仅允许 4 个候选，而且提议器只看到最近 10 条简略修改，缺少父节点专属的配对得失和执行成本。

## 本次实现

- 新配置 `configs/math-search-v3.json`：初始策略 + 最多 20 次候选实验，2600 次任务执行上限足以覆盖 21 × 119；取消额外搜索 token 总额度，仍保留每题 24k、4096 输出、12 步等原执行资源协议。
- 每轮在高分的最多 4 个可扩展节点中，以 0.3 均匀探索 + 0.7 温度 0.05 softmax 抽取父节点；准确率相同时先考虑较低逻辑 token 成本。
- 提议器获得完整祖先链、该父节点下所有已试子节点，以及少量其他分支的近况。经验包含真实纠错数、误伤数、完整性、资源可行性、成本、停止原因和派生后未整合次数。未完成候选不提供“完整准确率”。
- 验证失败样本按固定随机种子轮换抽取，附轨迹末尾的决策和停止信息，避免反复只看最前面的三题。
- 策略 hash 全局去重；合法操作仍由类型化语法产生，LLM 只提议合法 ID，MIA 使用真实配对执行结果选择实验。执行 agent 不接收评分标签、参考答案或搜索经验。
- 只在候选完整评测且资源可行后晋升；准确率相同且逻辑 token 更少也可晋升。部分评测只允许提前拒绝，不能作为完整方案导出。
- AFlow 式收敛：至少 8 次候选实验，已有 3 个完整可行策略，top 3 验证准确率均值在连续 5 次完整可行候选之后不变才停止。拒绝/失败候选不推进该窗口。这是明确的工程停止规则，不是统计显著性证明。

记录文件：`tree.json` 保存策略和父子关系；`experience.json` 保存各节点实测得失；`proposals.jsonl` 保存提议时的经验；`decisions.jsonl` 保存父节点候选与抽样概率；`curve.jsonl` 保存轮次、成本、最优策略及本轮得失；`summary.json` 保存选中策略的祖先链与停止原因。

## 实际运行问题与处理

1. **隐含 HTTP 30 秒超时**：通过 Ditto 发布包公开 `timeoutMs` 配置消除较短的隐藏截止时间，由 MFlow 每次调用的 90 秒期限负责取消。没有改动 Ditto 源码或 node_modules。
2. **停止原因混在一起**：保留兼容字段 `stopReason=tokens`，新增 `stopDetail` 区分供应商输出截断、单题预算不足、推理流程 token 限制。验证集中 s4 已有 16/119 条 token 停止记录；此项来自运行诊断，不是按 test 错题调整策略。
3. **test 退出却看起来仍在运行**：新版 standard evaluate 写出逐题 attempt、错误和状态，每题持久化 usage；`--resume` 校验 bundle、完整数据、评分代码及 Python/Node 依赖环境，跳过已完成前缀，只补跑未完成题目。未知 usage 与精确实耗分开报告，不自动无限重试。
4. **旧版 test 保护**：v2 在 400/486 后退出且未生成总结，未保留原始异常，不能确定根因。已复制并核对原 executionVersion、bundle、数据和评分器 hash，使用冻结实现恢复剩余题目。新版执行版本不同，旧 bundle 无法被新版 CLI 静默执行；新旧结果分别记录。
5. **基线的格式/角色问题**：已处理的 AutoAgents 花括号解析、缺失角色定义、含 `and` 的完整角色名误拆，以及 AFlow 注释化 prompt，见 [完整重跑协议](baseline-rerun.md)。不通过改 test 参考答案或调方法求解提示词来修复。
6. **长请求与供应商硬上限**：取消额外输出限制后，部分基线请求持续十多分钟。随后 usage 证实 EvoAgent、DyLAN、AFlow 各有调用生成至供应商输出硬上限（约 393k 输出 tokens），内容反复推导。原 DyLAN/EvoAgent runner 会因此终止整场测试；现将此类调用记为 `provider_output_limit`，该题计失败、答案留空、保留全部成本，继续其他题目。已记录的终态失败恢复时直接入账，不重新购买同一失败任务。AFlow 保留其原生重试控制。
7. **长请求观测盲点**：现有非流式接口在返回前无法区分仍在生成、排队或连接停滞；不能仅因进程存活就声称有进展。通用流式进度与取消后用量需求记录为 [DITTO-004](ditto-requirements.md#ditto-004长请求流式进度与取消后用量待支持)。不在 MFlow 复制 provider，也不额外截短基线答案。

## 运行

```sh
npm run build
npm run mflow -- search --config configs/math-search-v3.json \
  --search data/benchmarks/math/search.jsonl --out runs/math-search-v3/search
# 完成搜索并冻结 best.json 后：
npm run mflow -- evaluate --bundle runs/math-search-v3/search/best.json \
  --test data/benchmarks/math/test.jsonl --out runs/math-search-v3/test
# 同一冻结版本恢复中断评测：
npm run mflow -- evaluate --bundle runs/math-search-v3/search/best.json \
  --test data/benchmarks/math/test.jsonl --out runs/math-search-v3/test --resume
```

MATH 划分仍为原 AFlow validate 119 / test 486。新搜索使用全量 validate，从新的 Root 评测开始；不能把旧版 test 的正确率或错误内容回灌到提议器。v3 相比 v2 增加了搜索次数并修改了搜索控制，不能把最终差异全部归因于某一个改动；需要单独消融才可作该结论。

离线回归：44 项通过、1 项 Docker 环境跳过；7 项基线适配检查通过。覆盖非根节点继续派生、父节点专属失败保留、不完整分数隔离、收敛窗口、等准确率低成本方案晋升、评测续跑、故障调用成本，以及单题输出硬上限不终止整场测试。离线通过表示实现行为正确，不表示新策略准确率已经提升。
