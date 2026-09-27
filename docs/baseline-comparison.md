# MATH：官方 baseline 代码对比

> 本文记录已归档的受限实验。用户随后取消总额度及额外基线限制；当前运行以[完整重跑协议](baseline-rerun.md)为准。

本轮直接执行官方仓库中的控制代码，不在 MFlow 内重写四种方法。外部源码放在相邻的 `MFlow-baselines/sources/`；MFlow 只保存入口适配、版本锁和必要补丁。它们是统一模型及资源约束下的官方实现适配版，不是论文原始配置成绩。

## 固定设置

| 项目 | 设置 |
| --- | --- |
| 数据 | AFlow 发布划分：119 道 MATH validate，486 道 test；顺序及成员由 `data/aflow.lock.json` 校验 |
| 搜索 | 只使用 validate；test 不用于选策略、选提示词或调参数 |
| 模型 | DeepSeek `deepseek-flash`，thinking disabled，temperature 0 |
| 单次输出 | 最多 4096 tokens |
| 单题 | 最多 24000 tokens；调用前按序列化输入 UTF-8 字节数 + 输出上限 + 1024 预留，按供应商 usage 结算 |
| 总预算 | 历史 MFlow、当前 MFlow test、四个 baseline 的 pilot/search/test 合计最多 30,000,000 tokens |
| 评分 | 已冻结的 `scripts/grade_math.py` / math-verify；不因某个方法的 test 输出改评分器 |
| 随机性 | Python/NumPy 使用 seed 42（适用处）；供应商不保证请求完全确定 |
| 调用执行 | `@codesoul-co/ditto@0.1.1` 发布包的公共 SAMPLE / provider / TokenBudget；不导入 Ditto 源码 |

字节预留是保守上界，因而实际已用 token 不到 24000 时也可能无法发起下一次长上下文请求。这对 AutoAgents 尤其明显；不能把这种停止描述成算法自然收敛。

## 复用入口与适配范围

| 方法 | 官方控制入口 | 本轮配置与适配 |
| --- | --- | --- |
| AFlow | `scripts/optimizer.py` 的 `_optimize_graph`，原生图生成、父代选择、经验与工作流执行 | 基线 + 最多 4 次候选生成，每轮全部 119 题；搜索预算 2,280,742 tokens，与 MFlow 本轮实际搜索消耗对齐。算子配置为 Custom、ScEnsemble。完成的候选按验证分选最佳，平分取较早轮，冻结 graph/prompt 哈希后跑 test |
| DyLAN | `code/MATH/llmlp_gen_math_listwise_deeper_markov.py`，直接 `runpy` 执行完整脚本 | 原生 4 agents、最多 3 轮、早停共识和 top-2 筛选；保留官方 few-shot。统一模型/温度/输出上限；每题临时文件适配原生目录输入，评分用真实标签，脚本的未使用参考解填占位符 |
| AutoAgents | 原生 Explorer、Manager、observers、Group、CustomAction | 动态创建角色和计划，10 次外层轮次；模型传输替换为本地计费桥；关闭长期记忆，提示角色不使用外部搜索工具，保留本地 Print/WriteFile/FinalOutput；每题新建团队 |
| EvoAgent | `spp/util_func.py` 的 `collaboration_func` | 原生创建专家、质量检查、专家求解、答案整合，最多 3 次迭代；将 logic 提示词中的选择题答案格式换成 MATH boxed 答案；模型传输替换为计费桥 |

AutoAgents 和 EvoAgent 此入口没有原生 MATH 数据加载器；因此需上述任务格式适配。EvoAgent 的 `spp/agent_prompt_logic.py` 有一处模板变量声明与模板不一致、导致导入失败；唯一源码补丁在 `baselines/patches/evoagent-prompt-variables.patch`，不改变协作循环。其余算法控制代码直接来自锁定的仓库。

工具条件存在差别，不能宣称完全相同：MFlow 有 arithmetic；AFlow 的本轮算子列表不暴露 Programmer；AutoAgents 不使用网络搜索。AFlow 生成的工作流仍是原生 Python 代码。DyLAN 保留原生 few-shot，其他方法保留各自任务提示。报告须同时给出准确率、token、预算停止率，不能仅凭准确率归因于 spawn。

预算截断时：DyLAN 对已经完成的 solver 响应做原生答案提取与多数选择（可能跨轮）；EvoAgent 使用最后完成的整合答案，尚无整合则用初始答案；AutoAgents 使用最后发布的 Response，优先取 Final Output；AFlow 未完成工作流则记空答案。截断记录保留并参与全量评分，不丢弃失败题。正常完成时使用各自原生输出。

## 代码、凭据和账本

- 上游 URL、commit 和源文件哈希见 `baselines/sources.lock.json`。正式运行 `manifest.json` 固定适配代码、评分器、数据锁、Ditto 锁和 Python 依赖；续跑配置不符会拒绝。
- `.env` 仅由本机 `baselines/bridge.mjs` 读取；Python 进程只连接 `127.0.0.1:8197`，不持有真实 key。`.env`、原始题目输出、运行日志、虚拟环境不提交。
- 计费桥在已有 3,543,561 历史 tokens 上计费，并为 MFlow test 剩余题按每题 24000 tokens 留足额度。所有基线的成功、失败及 pilot 调用都记账；未知 usage 的失败按预留额计费。
- 账本为 `runs/baselines-math/usage.jsonl`；AFlow search 含候选生成与验证调用。原生 AFlow CSV 的 cost 单位在本适配中为 token，最终成本以公共账本为准。
- AFlow 优化器请求受搜索总预算约束，不套 benchmark 单题 24000 上限；候选工作流解题仍受单题上限约束。早期桥误套该上限，导致原始流程提前进入 test；这些记录已隔离到 `AFlow/initial-only-diagnostic/`，计费保留，不混入正式选优 test。
- `/status` 的 spent 仅为新基线账本；mflowReserved 为 MFlow test 已用加未完成题预留；remaining 已扣历史、基线与 MFlow 预留，不等于尚未实际消费的全部额度。
- 运行中不要重启计费桥；意外退出后先核对供应商与本地账本，在途请求可能尚未写入终态记录。只有一个桥可占用此端口。
- 三个直接 test 的 runner 可跳过已完成题续跑。原生角色/输出解析失败记为 execution_error、得分 0 并继续下一题，不重试以挑选更好的输出；传输错误仍停机检查。AutoAgents 首次此类失败已从 errors 记录补入结果，消耗没有重复。
- AFlow 初始 119 题全部完成后发生 NumPy 整数序列化错误：适配器已将累计成本转为 Python float。完整初始结果可重建元数据并复用，无需再次调用模型；生成候选后的搜索中断仍要求检查。冻结后可续跑 test。全局额度不足会停机，不能将未跑完的部分标为完整结果。
- 上述基础设施恢复保留原 manifest / manifest-history 和原因；没有依据 test 成绩更改原生提示词、策略、模型、单题限制或评分器。

## 环境与执行

Python 3.11；两个环境避免 AFlow 的 Pydantic 2 / OpenAI 1 与旧方法的 Pydantic 1 / OpenAI 0.28 冲突。依赖分别见 `baselines/requirements-aflow.txt` 和 `baselines/requirements-legacy.txt`。

在 MFlow 仓库目录运行以下准备代码，按锁定版本拉官方仓库，并应用已记录补丁：

```sh
python3 - <<'PY'
import json, subprocess
from pathlib import Path
root = Path.cwd()
for name, item in json.loads((root/'baselines/sources.lock.json').read_text()).items():
    target = root.parent/'MFlow-baselines/sources'/name
    if target.exists():
        raise SystemExit(f'{target} exists; inspect it before replacing')
    subprocess.run(['git','clone',item['repository'],str(target)],check=True)
    subprocess.run(['git','-C',str(target),'checkout','--detach',item['commit']],check=True)
    if 'patch' in item:
        subprocess.run(['git','-C',str(target),'apply',str(root/'baselines'/item['patch'])],check=True)
PY
uv venv --python 3.11 ../MFlow-baselines/.venv-legacy
uv pip install --python ../MFlow-baselines/.venv-legacy/bin/python -r baselines/requirements-legacy.txt
uv venv --python 3.11 ../MFlow-baselines/.venv-aflow
uv pip install --python ../MFlow-baselines/.venv-aflow/bin/python -r baselines/requirements-aflow.txt
```

先按主 README 准备数据、评分环境、Node 24、npm 依赖及 `.env`。本桥的历史记账常量和 MFlow 路径专用于本轮 30M 预算，不是任意新实验的默认配置。

```sh
node baselines/bridge.mjs
# 在另外的终端分别执行；共用同一个桥。
../MFlow-baselines/.venv-aflow/bin/python baselines/aflow.py --phase search-test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py DyLAN --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py AutoAgents --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py EvoAgent --phase test
```

运行产物在 `runs/baselines-math/<method>/`。正式 test 固定全部 486 题，不接受 `--limit`；`--phase pilot --limit 2` 只读取 validate。2 题 pilot 用于接口兼容性检查，不作为性能结论。

离线检查：`../MFlow-baselines/.venv-legacy/bin/python baselines/test_adapters.py`（不发起模型调用），以及 `npm test`。
