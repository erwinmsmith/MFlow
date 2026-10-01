# HLE / DeepSeek Flash comparison

Current service, network repair and progress commands: [2026-10-01 recovery](server-recovery-20261001.md). HLE retrieval currently uses the existing local proxy through an automatically reconnecting SSH relay; the Mac and proxy must remain online.

## Frozen protocol

- Pinned official `cais/hle@5a81a4c7` Parquet, SHA256 `6d0ee0602e8aea6b159509577e884f48ecac7b8e3f6822a35f51335a446c726a`; official evaluator `22ed3074`.
- `hle-full-holdout-v1`: 200 search (28 image questions) / 2300 independent test (314 image questions). Stratify by category × answer type × modality, largest-remainder allocation, seed 42 and SHA256 task ordering. All 2500 questions are covered. IDs, normalized question/image groups and locked hashes cannot cross roles. No author rationale or rationale image is exported.
- This is a **custom holdout comparison**, not official 2500-question full-test accuracy. The original text-only and complete official test-only views remain available via `MFLOW_HLE_PROTOCOL`; neither permits search.
- All five methods use `deepseek-flash`, temperature 0, thinking disabled, original question images and identical available tools: arithmetic, isolated Python and web_search. Tool execution is registered through published `@codesoul-co/ditto@0.1.1`; Python keeps code execution protection. Web retrieval applies the pinned official HLE blocklist to queries, result URLs/titles/snippets, rejects blocked site filters and 12-word verbatim question spans, and audits blocked calls. It may use public subject evidence, never benchmark answer keys or author rationales. No web_fetch tool or specialist libraries are supplied; this is a custom tool environment. Report as tool-augmented; do not compare directly to official no-tools scores.
- Same pinned official system/judge prompt and judgement schema; **DeepSeek Flash judge**, explicitly different from upstream's default `o3-mini-2025-01-31`. References enter only grading and search-failure feedback; test judgement never changes policies or templates. Judgements/confidence are saved; judge tokens are separately labelled and included in total costs. Accuracy is the primary score; calibration error is not currently reported.

## Native methods

MFlow measures five complete roots (single, review, plan/execute, parallel planning, adaptive factory), each with five full search-set passes. Original AFlow parent sampling, experience feedback, one focused mutation and convergence determine descendants and stopping. Both reusable heterogeneous internal graphs and the dynamic MAS derivation program are searched. Inference freezes the selected bundle, while its derivation rules may create task-local agents/programs outside the library. Question images are attached centrally to each public INFER call, including new agents; graph logs reference immutable image hashes instead of duplicating base64.

AFlow measures three static roots with the same complete passes and native controller. Original Custom, ScEnsemble and Programmer operators are available; Programmer executes through the public Ditto Python tool. DyLAN retains native debate/pruning/consensus, EvoAgent native role evolution/refinement, AutoAgents native manager/observer/group/actions. Only transport, academic output contracts, answer normalization and tools are adapted. Their 200-question development runs are measured, followed by all 2300 held-out questions. No benchmark answer is placed in persistent agent prompts or memory.

AFlow workflow files and MFlow bundles freeze before test. Answers/worlds are checkpointed before grading, so a judge outage does not repeat paid actor execution. Infrastructure failures stop a method for repair; model-output failures remain evaluation evidence. Fixtures verify wiring only, not model quality.

## Remote execution and progress

Snapshot: `hb:/home/b/project/experiments/deepseek-hle-20260930-v1/MFlow`. Own bridge port 8199, output `runs/hle-deepseek-flash-20260930-v1`, private DeepSeek profile, model/source/build/dependency/data hashes in manifests. Qwen and AutomationBench snapshots/services are preserved.

Retain the Qwen service. Start one method at a time; MFlow/AFlow initially have 2 concurrent episodes, with native concurrent graph nodes where applicable. Legacy methods have one worker. No total token/round/agent/depth quota or extra Context truncation. Before a new method starts, require 384 MiB available RAM (`MFLOW_MIN_AVAILABLE_MIB` overrides physical admission); queued status shows memory waiting. The baseline bridge is started only when required, avoiding its memory during MFlow. Increase concurrency in a **new frozen configuration** when measured RAM allows it.

```sh
# Local preparation (shared assets stay outside code sync):
../Benchmarks/collections/automationbench/official/.venv/bin/python benchmark-hub/prepare_extra.py hle --multimodal
# From the frozen snapshot on hb:
bash scripts/hb-model.sh deepseek python3 scripts/automation_experiment.py --benchmark hle --sequential
bash scripts/hb-model.sh deepseek python3 scripts/automation_experiment.py --benchmark hle --sequential --resume
# Remote progress from any local shell:
ssh hb 'cd /home/b/project/experiments/deepseek-hle-20260930-v1/MFlow; python3 scripts/automation_experiment.py --benchmark hle --status'
ssh hb 'systemctl --user status mflow-deepseek-hle-20260930-v1.service --no-pager'
```

`jobs.json` gives method/stage/queue status; `currentValidation` gives candidate/pass/completed/correct. Per-request progress is in `MFlow/search/requests` or bridge `requests`; costs include unknown-usage calls explicitly. A short-run score is provisional; compare frozen held-out results after full completion.

Official sources: [HLE](https://github.com/centerforaisafety/hle), [DeepSeek vision API](https://api-docs.deepseek.com/guides/vision/).
