# 本地共享 benchmark

独立数据目录默认为 `../Benchmarks`，可用 `BENCHMARK_HOME` 或 `--root` 指定。
管理器仅用 Python 3.9+ 标准库；不调用模型，不实现 agent。
本目录是管理器的版本控制源，`install` 将其部署到独立目录，部署后其他项目无需导入 MFlow。

```sh
python3 benchmark-hub/bench.py install
python3 ../Benchmarks/bench.py import-local --mflow-data data/benchmarks --official-data ../Ditto/benchmarks/data
python3 ../Benchmarks/bench.py list
python3 ../Benchmarks/bench.py verify
python3 ../Benchmarks/bench.py path math --split search
python3 ../Benchmarks/bench.py path gaia
python3 ../Benchmarks/prepare_extra.py automationbench
python3 ../Benchmarks/prepare_extra.py hle
```

迁移先验证已有哈希和上游 revision，然后在同一卷移动目录、保留原路径符号链接。
操作可恢复，重跑不得为改变的文件静默建立新校验基线。数据、原始下载、上游官方
评估代码和本地旧划分保留；现有实验产物留在各项目。后续环境输出、embedding cache、
模拟记录写入 `state/`，不修改固定源文件。不要提交 `collections/`、`views/` 或凭据。
GAIA 是授权数据，不可公开转存。
HLE 同样仅保留本地，访问同意与文件下载权限由 Hugging Face 账户管理。

## 协议

- DROP / HumanEval / MBPP / GSM8K / MATH：保留 AFlow `3f457218` 原 validate/test。
- HumanEval+：EvalPlus v0.1.10，原始 164 个任务。按 AFlow HumanEval 的 ID 归属
  导出 33 search / 131 test，顺序相同；使用 EvalPlus prompt，不把 canonical_solution、
  base_input、plus_input、contract 或 test 放入 agent 输入。它是继承 AFlow ID 的派生协议，
  不是上游提供的 HumanEval+ train/test；不能与原 HumanEval 视为独立任务族。
- GAIA：当前只有 2023 validation 和对应附件；没有下载隐藏答案的官方 test。
- BFCL：保存官方 V4 checkout。指定 commit，不能默认宣称与在线 leaderboard 的 pin 一致。
- τ³：保存官方 v1.0.1 checkout，原始领域政策、工具、任务与 split 保留。
- GAIA/τ³ 只管理资产和官方评估代码。BFCL 已提供 SingleLLM 四类多轮的独立执行入口 `scripts/bfcl_single.mjs`（800 题），尚未接入 MFlow 搜索；详见 `docs/shared-benchmarks.md`。
- HLE：完整 2500 题（342 图片题）；保留原 2158 无图题 test-only view，新增全量 test-only 和单独命名的分层 200 search / 2300 test 自定义协议。图片经已发布 Ditto 公共接口传递。
- AutomationBench：固定 Zapier 1.0.6，200 simple 开发搜索 / 600 public domain 评测。
  该命名开发协议不等于官方 train/test 或私有 leaderboard；保留官方 API 环境和 strict/partial 评分。

没有统一随机切分这些数据。GAIA 新切分要明示为开发协议；BFCL Memory 的预填充
与问答属于同一任务族；τ³ 原始 train/test/base 不能混用。参考答案、预期动作和用户模拟器
私有目标只给相应评分器/模拟器，不能给待测 agent。所有对照方法必须冻结相同任务清单、
工具环境、评分器和版本，并将 agent、模拟器、检索/embedding 与搜索开销分别计账。

## HumanEval+ 评分环境

```sh
docker build -f ../Benchmarks/Dockerfile.evalplus -t mflow-evalplus:0.1.10 \
  ../Benchmarks/collections/official-20260930/HumanEval+
```

镜像载入固定官方 checkout 的 `evalplus` 模块；调用官方 `trusted_exec` / `untrusted_check`，
保留默认 oracle、容差、动态超时和 base+plus 两组测试，最终成功要求两组都通过。
执行生成代码时通过 Ditto Sandbox 启动禁网、只读、非特权 Docker，镜像 ID 写入运行 manifest。
基础设施失败抛错，不记为模型答错；脚本 fixture 或参考答案通过仅证明接线。
