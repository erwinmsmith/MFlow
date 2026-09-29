# v6 optimizer Context incident and recovery

At 12:59 Asia/Shanghai, MFlow's process was alive but only the initial candidate had actually been evaluated. Five full MATH validation repetitions scored 102, 102, 98, 98, 102 out of 119 (502/595 = 84.3697479%).

Every subsequent proposal failed before calling the optimizer model: the combined parent composition, profiles, execution evidence, failures and instructions exceeded the published Context Worker's default 64 KiB inline-item limit. The adapter sent these already-complete messages through an unnecessary CONTEXT.LOAD before INFER.REASONING.TRAJECTORY. Native AFlow's skip-on-error behavior advanced round numbers without producing candidates. There were 342 failed proposal attempts, zero optimizer provider usage records and no candidate strategy beyond round 1. Those round numbers are not valid experiment progress.

## Repair

- Structured optimizer/factory calls now bind the complete messages directly into the published INFER.REASONING.TRAJECTORY node. Nothing is truncated or summarized, no extra context limit is imposed, and the agent composition's own Context nodes remain unchanged.
- Unexpected proposal infrastructure/format errors return `fatal`; the Python adapter stops at the current checkpoint instead of advancing a phantom round. Existing explicitly classified policy-contract failures retain their separate behavior.
- A registry Context policy override was considered and rejected during testing: the public validator itself bounds integer policy values. The final implementation does not override that policy or modify the package.

## Recovery invariants

Keep all 595 completed task records byte-for-byte. The initial composition, prompts, profiles, model, task split, inference graphs and scoring are unchanged. Preserve the original controller/manifest and hashes in `runs/math-aflow-v6-20260929-01/context-recovery-audit.json`; use a separate compiled runtime snapshot. Archive the empty failed-round directories, reset the controller to round 1 / generating with seed 42 (the point before proposing candidate 2), and retain all initial validation rows. No candidate had been generated and no optimizer model call had taken place during the discarded bookkeeping iterations.

Regression checks cover intact optimizer messages above 64 KiB and fatal proposal failures leaving the controller at round 1 with no round-2 candidate. Fixture results test the adapter, not benchmark quality.
