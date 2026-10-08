# DROP / MBPP Docker outage recovery (2026-10-08)

A Docker daemon outage interrupted local DeepSeek Flash evaluation. Docker's CLI
returned exit 1 when it could not connect. The Python grader had treated that exit
like a candidate assertion failure, so some MBPP answers received false zeros.
Python tools also returned execution errors to agents during the outage.

## Runtime fix

- A unique startup marker is emitted by the container shell before executing
  Python. Missing markers and Docker startup exit codes are infrastructure errors.
- The Python tool reports `TOOL_INFRASTRUCTURE`; inference stops before another
  model request, and the baseline bridge preserves its transport-failure category.
- Candidate assertion failures still score zero; candidate timeouts retain the
  existing code execution protections. Container cleanup remains unconditional.
- Earlier repeated-tool-cycle protections remain enabled. No search, context,
  token, agent or depth quota was added.

## Recovery protocol

All four affected local supervisors were paused before repairing files. Docker
Desktop was restarted and its Python images verified by the regression tests.
The audit is outside the repository at
`../experiments/docker-outage-20261008/recovery.json`, with a compressed copy of
modified/deleted artifacts in `before.tar.gz`.

- MFlow: retry rows with recorded Docker tool failures, irrespective of score;
  preserve usage records and unaffected rows. Regrade the 13 remaining MBPP
  answers committed in the outage window without new model requests.
- Legacy MBPP baselines: full tool traces are not retained. Conservatively retry
  every completed episode whose checkpoint overlaps the outage window, irrespective
  of its score: DyLAN 35, EvoAgent 87, AutoAgents 43. Keep the other 306, 131 and
  207 completed rows respectively.
- AFlow MBPP: repair round 7 evaluation. Quarantine round 8, which was generated
  using the corrupted round 7 feedback. Resume round 7's original candidate and
  parent. Keep the persisted random state and all original request/cost ledgers;
  do not claim this reproduces the counterfactual uninterrupted search trajectory.
- DROP AFlow text scoring does not use Docker, but full tool traces are unavailable.
  Conservatively retry its 2,076 outage-window episodes irrespective of score,
  resuming round 44 and quarantining its subsequent candidates. Earlier rows remain.

The conservative baseline window begins at 2026-10-08 11:28:35 Asia/Shanghai,
just before the first observed false-zero pass. Archived attempts remain part of
experiment cost. Faulty scores must not be quoted as benchmark performance.
Search and test remain separate; this recovery does not use test results to
modify prompts, candidates or search selection. Final test follows search.
