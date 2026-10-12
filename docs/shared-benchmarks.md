# Shared benchmarks

The external benchmark hub lets multiple projects share immutable source data, named views, and official evaluation assets. The manager is versioned in [`benchmark-hub/`](../benchmark-hub/README.md); the portable public split release is in [`benchmark-splits/`](../benchmark-splits/README.md).

## Storage and paths

```text
Benchmarks/
  bench.py                     # Standalone manager
  catalog.json                 # Sources, protocols, paths, support
  manifests/files.json         # Source file hashes and sizes
  collections/                 # Immutable downloads and official checkouts
  views/                       # Named prepared protocols
  environments/                # Grading and benchmark dependencies
  state/                       # Mutable outputs and caches
```

The default is `../Benchmarks`, or set `BENCHMARK_HOME` explicitly. Keep credentials, datasets, and results outside Git. Existing-project migration verifies content before moving assets and preserving symlinks; it does not reinterpret historical runs.

```sh
python3 benchmark-hub/bench.py install
python3 ../Benchmarks/bench.py list
python3 ../Benchmarks/bench.py verify
python3 ../Benchmarks/bench.py path math --split search
python3 ../Benchmarks/bench.py path humaneval_plus --split test
```

For a fresh machine, use the public split preparation commands rather than depending on another user's local directory. The hub's `import-local` command is for existing downloads. The original `mflow benchmarks --name all --out <directory>` importer also prepares the five fixed AFlow subsets.

## Supported scope

| Benchmark | Search / test | Execution and scoring |
| --- | ---: | --- |
| DROP | 200 / 800 | Search/evaluate; mean token F1, with F1=1 rate separately |
| HumanEval | 33 / 131 | Python generation and isolated tests |
| MBPP | 86 / 341 | Complete Python output; hidden-test pass@1 |
| GSM8K | 264 / 1,055 | Final numeric answer |
| MATH | 119 / 486 | `math-verify`; separate full upstream assets are not this subset |
| HumanEval+ | 33 / 131 | Official EvalPlus base+plus checks; dedicated image required |
| BFCL | 200 / 600 | MFlow and baselines; four multi-turn categories, official worlds/scorer |
| AutomationBench | 200 / 600 | Official public API worlds, strict success and partial credit |
| HLE | 200 / 2,300 custom holdout | Text/image actor input, tools where configured, separately metered judge |
| GAIA | No MFlow split | Official 2023 validation assets/attachments only |
| tau3 | No MFlow split | Official checkout and source protocols only |

HLE also retains separate 2,158-text-task and 2,500-full-task test-only views. These overlap the holdout and cannot be mixed for independent evaluation. Dataset support is distinct from provider capability and local grading-environment readiness.

The [split release](../benchmark-splits/README.md) records all source revisions, counts, order, grouping, and hashes. Five AFlow subsets retain the original validation/test membership. **DROP has five locked duplicate prompt pairs and shared passages across partitions.** HumanEval+ inherits HumanEval task IDs and is not an independent task family. GAIA authorized attachments and HLE gated data must remain local.

## Model and dataset entry points

```dotenv
BENCHMARK_HOME=../Benchmarks
MFLOW_BENCH_PYTHON=../Benchmarks/environments/text/bin/python
MFLOW_EVALPLUS_IMAGE=mflow-evalplus:0.1.10
```

```sh
npm run build
npm run mflow -- benchmarks list
npm run mflow -- benchmarks --verify
npm run mflow -- benchmarks path --name HumanEval+ --split test
```

The loader accepts `benchmark:math/search` and `benchmark:humaneval+/test`. Explicit `--search`/`--test` paths take precedence over `--benchmark`. Unsupported GAIA/tau3 search/test views fail explicitly.

The following examples invoke the configured model:

```sh
npm run mflow -- seed --benchmark drop --initialization single --out runs/drop-single/seed.json
npm run mflow -- evaluate --benchmark drop --bundle runs/drop-single/seed.json \
  --out runs/drop-single/test --concurrency 16
```

Replace `drop` with `mbpp` for code generation and prepare the local `python:3.12-alpine` grader image first. These two SingleLLM controls use one tool-free root call, without spawning or tool creation. MBPP hidden tests stay in the evaluator. Frozen bundles record prompts and model options; `task-usage` retains original calls and retries. Resume with the same command plus `--resume`.

## DROP / MBPP full comparisons

`scripts/automation_experiment.py --benchmark drop|mbpp` supports MFlow, AFlow, DyLAN, EvoAgent, AutoAgents, and SingleLLM. Prepare pinned baseline Python environments and the sandbox image before launching:

```sh
python3 scripts/automation_experiment.py --benchmark mbpp --run runs/mbpp \
  --methods MFlow AFlow DyLAN EvoAgent AutoAgents SingleLLM \
  --concurrency 16 --legacy-concurrency 2 --port 8201
python3 scripts/automation_experiment.py --benchmark mbpp --run runs/mbpp --status
```

The first command invokes models; the status query does not. Use the same frozen snapshot and `--resume` to continue. DROP commonly uses port 8200 and model concurrency 32; these are operating configurations, not changes to the algorithms.

MFlow preserves one single-root search tree, native AFlow parent sampling, five complete repetitions, experience feedback, convergence, and final-only test. Diversity comes from later branches: evidence localization/counting for DROP, specification/algorithm/boundary checks for MBPP, and heterogeneous node graphs where useful. Each child inherits the complete selected parent artifact and measured executions. Test starts with one root and runs the frozen dynamic policy.

AFlow uses its native Custom/ScEnsemble operators and task-specific prompts. DyLAN debate/pruning, EvoAgent evolution, and AutoAgents Manager/observer/action control retain their upstream algorithms and run test directly. Actor tools execute through Ditto. AutoAgents' custom search exposes only public task content; it does not retrieve benchmark answers. AFlow's hidden-test-reading Test operator is not exposed for MBPP. Model-authored checks may use public examples and self-created inputs.

All methods verify the same split hashes. DROP optimizes mean F1 and separately reports perfect-answer rate. MBPP uses complete raw Python, without math `boxed` extraction. Different benchmarks require separate searches; a selected MATH artifact is not a universal policy.

## BFCL

See [the full comparison protocol](bfcl-comparison.md). The custom `bfcl-multiturn-family-v1` protocol has 50 search and 150 test conversations per category. MFlow and all baselines use the same official world interface, function visibility, whole-conversation boundaries, and pinned scorer. No Docker task containers are required for this BFCL interface.

A separate historical native function-calling SingleLLM adapter, `scripts/bfcl_single.mjs`, evaluates all 800 conversations without a search split. It retains the official per-turn controller, function-document conversion, and missing-function release timing. Do not combine that score with the 600-task same-interface comparison.

```sh
uv venv --python 3.11 ../Benchmarks/environments/bfcl
uv pip install --python ../Benchmarks/environments/bfcl/bin/python -r benchmark-hub/bfcl-requirements.lock.txt
node scripts/bfcl_single.mjs --run runs/bfcl-native-single --status
```

Use `MFLOW_BFCL_PYTHON` for an alternative environment. Native actor calls and registered external tools execute through Ditto; official state and response checks grade saved predictions. Resume validates manifests, skips committed tasks, and restores unfinished conversations through recorded model responses and replayed tool calls. Unknown usage is reported separately.

## HLE and AutomationBench

Installed preparation commands:

```sh
python3 ../Benchmarks/prepare_extra.py automationbench
python3 ../Benchmarks/prepare_extra.py hle
```

HLE requires authorized Hugging Face access. The three views preserve their own explicit protocol names. Full views pass images through Ditto's public model interface. HLE grading reuses the pinned official judge prompt/schema; reference answers go only to the judge. Set `MFLOW_HLE_JUDGE_MODEL` explicitly and report it. Substituting DeepSeek for the pinned official evaluator's `o3-mini-2025-01-31` is a scoring change. Judge tokens are included in actual usage under `hle-judge`; current summaries report accuracy rather than calibration error. See [HLE experiments](hle-experiment.md).

AutomationBench pins Zapier's official task builders, API schemas, permitted services, worlds, and assertions. Its 200 simple search / 600 public-domain test protocol is a custom development split, distinct from the private leaderboard. Registered `api_search`, `api_fetch`, and `base64_encode` tools execute through Ditto Interaction. Members share one task world; new tasks/retries reset it. Grading restores a saved world/contract rather than generating a new answer. Strict success is primary; partial credit is separate. Side-effecting worlds do not use legacy prefix caching or continual evaluation. See [AutomationBench experiments](automationbench-experiment.md).

## HumanEval+ and code grading

The EvalPlus release and evaluator are pinned in `data/humaneval-plus.lock.json`. Build the dedicated image using [the hub instructions](../benchmark-hub/README.md). Both base and plus tests must pass. Canonical solutions, hidden inputs, contracts, and grader metadata are never actor inputs.

Code executes through the published Ditto Sandbox with network disabled, restricted mounts/privileges, and time/resource guards. Record the image ID rather than only a mutable tag. Infrastructure failures suspend evaluation; a saved prediction can be regraded after repair without another generation. Correct fixture/reference programs establish wiring, not benchmark quality.

## Recovery and storage

Frozen manifests identify data, runtime, model, official sources, scorer, and images. Resume must not silently mix a new build with old results. Explicit engineering repairs retain checksum receipts, original manifests, committed rows, and all prior usage. An interrupted uncommitted task can restart; its earlier cost remains.

The October DROP/MBPP repairs distinguished invalid MAS contracts from provider/grader infrastructure failures, added independent cleanup for timed-out code containers, and detected unchanged repeated action/result cycles. AutoAgents formatting repairs stop after repeated failures and use their native schema instructions. These fixes preserve task membership and native search control.

Store concise results, checkpoints, and usage. Keep large source assets shared, avoid repeated full tool schemas/world dumps in traces, and do not remove evidence needed for scoring, recovery, or cost accounting. Disk figures and test counts in dated historical documents describe those snapshots, not current installation requirements.
