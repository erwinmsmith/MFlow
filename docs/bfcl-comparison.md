# BFCL multi-turn comparison

## Protocol and fairness

`bfcl-multiturn-family-v1` uses the pinned BFCL V4 checkout at revision
`6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`. Scope: base, miss_param,
miss_func and long_context, 200 conversations each. This is a custom comparison,
not the complete BFCL leaderboard.

`python3 benchmark-hub/prepare_bfcl.py --root ../Benchmarks` creates deterministic
200 search / 600 test views (50 / 150 per category). Numeric task families stay
on one side; identical normalized initial public questions join the same family.
Seed 42 orders groups by SHA256. No model results or reference answers select
the split. The lock records dataset, function documents, environment and scorer
hashes. The shared catalog makes both splits available through `--benchmark bfcl`.

All six methods use exactly the same 600 test IDs and three Ditto external tools:

- `bfcl_state`: current public conversation and currently available function schemas.
- `bfcl_call`: current turn plus a batch of actual official function calls.
- `bfcl_respond`: submit a response/clarification and reveal the next user turn.

One official world is shared by every agent for the entire conversation. Agent
structures and generated tools survive user turns. Turn numbers reject stale
concurrent actions. Calls execute serially inside each world; separate questions
run concurrently. Future messages, withheld function schemas, hidden world state
and grading references are never returned to actors. Missing functions are released
on their original official turn. Function names and literal arguments are checked
before entering the official executor. The pinned official per-turn action-batch
limit applies (its controller stops after count > 20). Helper reads and responses
are interface operations, not official action batches.

The exact pinned official multi-turn entry evaluator scores replayed function
calls using state and response checks. A textual claim is never evidence of an
executed effect. Checkpoints record function calls/responses for official replay;
no giant hidden-world snapshots are saved. Infrastructure faults propagate; ordinary
invalid tool arguments return observations. Unavailable-function attempts score
zero, matching the native SingleLLM adapter's treatment.

## Methods

- MFlow: one tree rooted in **one agent**. The existing AFlow search controller,
  five validations per candidate, parent selection and convergence are unchanged.
  Mutations jointly optimize MAS orchestration, heterogeneous subagent node graphs,
  evidence routing and dynamic spawn policies. Agents may create reusable tools
  using granted Ditto capabilities. Diversity is explored in later tree branches.
- AFlow: official static Python workflow, Custom and ScEnsemble operators; native
  search/experience/convergence, five validations. Planning and ranking cannot act.
- DyLAN / EvoAgent / AutoAgents: existing official debate/evolution/role-design
  controllers, with BFCL task and output prompts and the shared Ditto environment.
  They run test directly, without an extra search stage.
- SingleLLM: single agent, same three tools, no spawn or tool creation.

MFlow and AFlow test their selected best candidate only after search completes.
No per-round test. DeepSeek Flash, temperature 0, thinking disabled, same provider
options as previous experiments. Token accounting separates optimizer, search and
final test, including failed requests when reported by the provider.

The earlier native FC SingleLLM 800-task result (53.50%) uses a different interface
and full scope. Keep it as a separate reference; do not mix it with the new 600-task
same-interface SingleLLM comparison.

## Run and resume

Prepare the official environment as described in `shared-benchmarks.md`, build,
and select a private model profile. BFCL requires no Docker task containers.
Freeze code and baseline sources before launching:

```sh
python3 scripts/automation_experiment.py --benchmark bfcl --run runs/bfcl \
  --methods MFlow AFlow DyLAN EvoAgent AutoAgents SingleLLM \
  --concurrency 8 --legacy-concurrency 2 --port 8202
python3 scripts/automation_experiment.py --benchmark bfcl --run runs/bfcl --status
```

Add `--resume` using the same snapshot/config to retain completed tasks, rounds,
usage and final conversation checkpoints. An interrupted in-flight conversation
without a completed checkpoint restarts; completed tasks are not charged again.
External tool execution uses the registry-published Ditto package only.
