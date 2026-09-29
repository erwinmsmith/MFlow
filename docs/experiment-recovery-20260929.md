# 2026-09-29 断点恢复记录

## MFlow

v8-20260929-03 因供应商响应流 terminated 退出。恢复前确认同一 registry 包、冻结代码与配置、模型服务及 Docker 可用，原命令追加 `--resume`。保留 356 条已完成评估，继续 round 1 第三遍最后一题及后续重复，不重新评分已完成题，也不更换策略/提示词。恢复事件和 PID 写入该运行的 experiment.json。

## AFlow

官方控制器仅完成 15 个候选的验证。日志中第 16–21 轮为技术失败、score=None；控制器耗完循环后返回，于 18:12 冻结 round 12（验证 118/119）。这不是收敛完成的 21 轮搜索。保留此已冻结选择继续 test，test 结果不得用于重新选择或继续搜索。

本次中断前 test 有 290 条记录：250 条执行完成（244 正确、6 错误），40 条空答案的 TransportFailure 被错误记成了 0 分。恢复操作先将原 290 条记录及 SHA-256、40 条故障记录完整归档至运行目录，再仅保留 250 条 completed 记录，包括全部 6 条正常错误答案。随后重试 40 条基础设施故障并继续未运行题，共 236 题；此前消耗仍保留在原 usage ledger。

`scripts/resume_aflow_test.py` 只接受已有 frozen.json，沿用原 adapter 的 manifest/工作流哈希验证及按任务 ID 跳过完成结果的逻辑。新增传输故障边界使用 BaseException 穿透原生答案重试/评分，在后端故障时停止且不写假 0 分；原生模型输出上限的处理保持原样。没有更改官方搜索器、工作流、模型、划分或 grader。

运行方式：

```sh
../MFlow-baselines/.venv-aflow/bin/python scripts/resume_aflow_test.py
```

本地 bridge 必须正常监听 127.0.0.1:8197。该脚本不自动清理历史故障分数；历史数据恢复需要逐项审计并归档。恢复状态写入 AFlow/test/recovery-status.json，最终 summary 仍由原 test adapter 生成。
