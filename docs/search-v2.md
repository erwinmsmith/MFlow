# 搜索控制 v2：从可执行反馈改进派生策略

本文保留 v2 历史协议；新的 20 次候选实验、父节点专属经验和恢复机制见 [搜索控制 v3](search-v3.md)。此前 30M 总额度已由用户取消。

## 为什么第一轮没有派生

旧版 MATH 搜索 Root 在 119 道验证题中得到 88 题正确，但未报告任何 deficit。按已出现状态过滤的语法无法提出 DERIVE；单独增加 DERIVE 也不保证有 CONNECT 和 Root 整合路径。某些不可执行动作仍占用步骤与实验次数。因此这轮不能证明搜索有效。

## 参考与实现

参考固定版本 AFlow `3f457218fc716093fe53f6df8a5d5e6379d66346`：

- [optimize_prompt.py](https://github.com/FoundationAgents/AFlow/blob/3f457218fc716093fe53f6df8a5d5e6379d66346/scripts/prompts/optimize_prompt.py)：基于失败轨迹、父策略得分、历史修改提出一次完整变化，强调 review/revise 和信息流连通。
- [MATH operator prompts](https://github.com/FoundationAgents/AFlow/blob/3f457218fc716093fe53f6df8a5d5e6379d66346/workspace/MATH/workflows/template/op_prompt.py)：独立解答、复核与证据整合。
- 父节点仍按实测 utility 选 top 4，混合 0.3 均匀探索和温度 0.05 的 softmax。MFlow 保留类型化策略、MIA 和受影响轨迹复用，不生成任意 Python workflow。

### 提示词

`src/prompts.ts` 集中保存执行、复核、Factory 和优化器提示词。执行时检查具体约束、遗漏情况与未验证计算，允许在暂定答案存在时报告真正未解决的问题；支持性 claims 在最终答案之前。Factory 根据具体问题选择不同方法与能力，不设固定角色目录。子 agent 必须回传可核查的计算、论证或反例，Root 检查后才能关闭自己的 deficit。

### 完整候选操作

- `REVIEW`：同一个 owner 独立复核一次，记录 `reviewed`，可直接修正答案或发现具体缺口。
- `DERIVE → CONNECT → CONTINUE`：把派生、证据交付、owner 整合放入一个完整局部操作，避免派生结果无法影响最终答案。
- `CHALLENGE → CONNECT → CONTINUE`：即使 Root 没有主动报告缺口，策略也可要求一次独立求解检查。此请求明确标记为策略要求的验证，不声称已知答案错误。独立求解的 Factory 和子 agent 不获得父答案，减少锚定；常规 deficit 派生仍可参考父证据。记录 `challenged`，每个 owner 只触发一次。
- 策略匹配跳过不可执行的 DORMANT、无新 artifact 的 CONNECT 等动作。资源预算仍由运行时硬性检查。

这些都是可选的搜索候选，初始 Root 策略没有默认派生。新增 agent 本身不算收益；只有完整验证结果更好且满足资源限制，候选才晋升。

### AFlow 式反馈提议 + MIA

配置 `proposalMode: "aflow"` 后，优化器获得父策略、真实验证准确率、最多三个失败轨迹、最近十个历史修改和合法操作列表，返回最多四个操作 ID。标准答案不传入执行 agent，也不传入提议器。输出经过合法 ID 检查后，MIA 仍使用真实成败观测选择实验；模型不能编造质量或信息增益分数。`proposalMode: "grammar"` 保留不调用提议器的对照模式。

渐进评估可以提前拒绝有害候选；只有完整受影响集合评测结束才能晋升。无决策分歧的任务继承已观测父轨迹，不假设另一条随机执行也必然相同。

## 运行与版本

- 只用 registry 发布的 `@codesoul-co/ditto@0.1.1`，没有 Ditto 源码依赖。
- 删除 Context 与 Infer 消息的重复注入，减少输入与预留成本。
- DeepSeek Flash 通过 Ditto 公共 `providerOptions` 启用 [JSON Output](https://api-docs.deepseek.com/guides/json_mode/)，保留严格 schema 校验；截断只终止当前 episode，非截断的格式错误最多经 Ditto 修复一次（保留答案、计入预算），修复后仍不符合 schema 则报错。
- bundle 升为 v3，记录执行版本与执行提示词摘要。CLI 拒绝不同版本的 bundle，避免旧策略被新提示词静默执行。旧 bundle 必须用原提交重现。
- MATH 官方运行仍为 AFlow validate 119 / test 486。诊断仅从 validate 选取，明确不作为全量准确率。
- `configs/math-search-v2.json`：4 次候选实验、最多 800 次任务执行、12M 搜索 token、24k 每题、4096 最大输出。预算上限不是预期消耗，所有失败和诊断成本也计入用户的约 30M 总额。

完整搜索：

```sh
npm run build
npm run mflow -- search --config configs/math-search-v2.json \
  --search data/benchmarks/math/search.jsonl --out runs/math-search-v2/search
```

先冻结策略与执行版本，再进行 test；test 从不用于候选提议、调提示词或策略选择。

诊断还发现 MATH 的文字答案（如单词、姓名和选项）缺少数学包装时可能无法被 math-verify 提取。评分器对文本型 gold 的纯文字答案补充同等包装；不会从解释性句子中猜测答案。新运行会重新评测基线，旧版分数不可直接用于归因。测试评测即使异常也会保存 usage。
