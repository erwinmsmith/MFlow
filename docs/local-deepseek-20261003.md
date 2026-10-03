# Local experiment recovery — 2026-10-03

Both v5 comparisons exhausted the configured provider balance (HTTP 402). The supervisors were stopped, with job receipts saved as `provider-outage-20261003.json`. After the user confirmed recharge, the same frozen snapshots resumed successfully. Completed results and failed-call accounting are retained.

An independent engineering failure stopped MFlow's AutomationBench round-1 observer at 147/600: its full `test.jsonl` was 2,198,409,859 bytes, exceeding Node's whole-file read limit. Serial and concurrent evaluators now stream completed rows and retain only scores/token summaries plus full-row conflict fingerprints in memory. Original executions and complete result rows remain on disk; wrong answers remain completed results. Progress includes a correct count so monitoring need not parse gigabytes of execution traces.

For existing immutable snapshots, `scripts/evaluation_io_repair.mjs` applies the compiled evaluation I/O fix only to the `evaluate` entrypoint. `MFLOW_EVALUATION_IO_REPAIR` points to a receipt containing the original module, replacement module and both SHA-256 hashes. The hook validates both files before loading. Search, actors, prompts, grading, datasets and registry Ditto are unchanged. The repair and scheduler have separate versioned receipts; original experiment manifests are retained without modification.

Regression checks cover streaming without `readFile(test.jsonl)`, trace preservation on disk, conflict detection, and checksum/entrypoint restrictions on the repair. Model degeneration and context-limit failures remain scored outcomes; provider failures resume without counting unfinished tasks as completed. Partial test scores must not guide search or prompt tuning.

AFlow also propagated a transport failure before its other evaluation threads finished. During interpreter shutdown, 45 search episodes in round 5 / pass 1 caught executor-shutdown errors as ordinary episode failures. The adapter now drains already-started threads and stops scheduling on an infrastructure failure. Those 45 result/world checkpoints (including five provisionally scored successes) were archived for rerun; all cost records remain. No test record or genuine model failure was removed. Round 5 had not completed or entered selection. The archive and exact IDs are in `engineering-repair-20261003/recovery.json`.

`scripts/aflow_drain_repair.py` supports these frozen runs through a separately recorded, checksum-verified replacement of only `evaluate_static`; actor and workflow functions remain from the original snapshot. The scheduler receives its path as `MFLOW_AFLOW_RUNNER` and the receipt as `MFLOW_AFLOW_DRAIN_REPAIR`.

## Parallel checkpoint repair (13:40 CST)

MFlow's parallel seed exposed a shared persistence bug: concurrent nodes wrote the same usage `.tmp` file, then raced to rename it. All 200 results of AutomationBench round 3 / pass 0 contained this explicit `ENOENT` execution error; none is valid model-quality evidence. The shared `save` helper now snapshots values at invocation and serializes commits per absolute path, allowing unrelated paths to proceed independently. A regression check covers 100 overlapping saves and recovery after a write failure.

The 200 result/execution checkpoints and their derived pass feedback were archived in `state-io-repair-archive-20261003`, before this candidate completed validation or entered selection. Existing usage records remain for resumed accounting; original failed writes may have left gaps. Earlier candidates and all test rows remain intact. The existing checked I/O hook also accepts `MFLOW_STATE_IO_REPAIR`, a separate receipt for the application `util.js` module. Snapshot files, agent policies, prompt contents, grading and Ditto remain unchanged.

## HLE judge output contract

Following another network interruption, HLE AutoAgents was also repeatedly failing while grading a saved answer: the judge returned prose instead of the required JSON object. The structured-call adapter now forwards the published Ditto `ModelConfig.providerOptions`, and HLE grading explicitly requests `response_format: {type: 'json_object'}`. The official judge prompt, verdict schema, judge model, temperature and correctness rule are retained; actor calls do not receive this judge-specific constraint. Invalid verdicts never become scored answers.

Two real-provider arithmetic fixtures (one correct answer, one incorrect answer; no benchmark data) returned valid expected verdicts, consuming 1,074 tokens in total. This is a transport/format check, not benchmark-quality evidence. Existing valid grades remain, and unfinished grading resumes from the saved actor answer. The frozen HLE run records separate checked replacements via `MFLOW_HLE_JUDGE_REPAIR` and `MFLOW_MODEL_OPTIONS_REPAIR`; AutomationBench and Qwen are unaffected.
