# MFlow

MFlow searches for a reusable multi-agent organization program. Each candidate includes the MAS structure, dynamic spawning and routing rules, agent profiles, internal Ditto graphs/loops, templates, tools, and prompts. Inference executes the selected frozen program and starts each task with one root agent.

All executable agents use the registry-published **`@codesoul-co/ditto@0.1.2`** through public exports. Ditto owns model, reasoning, and tool execution. MFlow owns datasets, organization policy, evaluation, and statistical search.

## Start here

- [Reproduce the exact benchmark splits](benchmark-splits/README.md)
- [Shared dataset manager](benchmark-hub/README.md)
- [Pinned baseline sources](baselines/sources.lock.json)

## Install

Requires Node.js 24+, npm 11+, and Python 3.9+ for dataset utilities. Benchmark-specific graders and upstream baseline environments have additional dependencies.

```sh
npm ci
npm test
cp .env.example .env
npm run mflow -- doctor
```

Set `MFLOW_BASE_URL`, `MFLOW_MODEL`, and `MFLOW_API_KEY` in the ignored `.env`. Ditto's public HTTP provider supports OpenAI-compatible endpoints. DeepSeek Flash and Qwen served by llama-server have experiment configurations; other providers require their own tool/schema compatibility checks. `MFLOW_PROVIDER_OPTIONS` supplies additional provider options.

DeepSeek configurations use temperature 0 and disable thinking. DeepSeek requests do not transmit the local search seed. HLE requires an explicitly configured judge model; image tasks also require a compatible actor endpoint. Model parameters, runtime identity, and grader versions are frozen per run.

## Reproduce the datasets

The public split package contains ordered task IDs, source revisions, content hashes, and verification tools. It contains no dataset questions, reference answers, credentials, or experiment traces. Other projects can use it without Node, Ditto, or a model account.

```sh
python3 benchmark-splits/splits.py list
python3 benchmark-splits/splits.py prepare --benchmark math --download --out ../ReproducedBenchmarks/math
python3 benchmark-splits/splits.py verify --benchmark math --data ../ReproducedBenchmarks/math
```

[All protocols and preparation commands](benchmark-splits/README.md) cover DROP, HumanEval, MBPP, GSM8K, MATH, HumanEval+, AutomationBench, BFCL, and three separately named HLE views. GAIA and tau3 currently have asset management only.

Use the published membership rather than rerunning a random split. Search and test counts refer to the selected protocol, not necessarily the full upstream dataset. **AFlow's DROP split has five known cross-split duplicate prompt pairs and shared passages.** They remain for historical reproducibility and are explicitly disclosed; this split is not fully overlap-free.

For multiple local projects, [the benchmark hub](benchmark-hub/README.md) manages one external `Benchmarks/` directory. `BENCHMARK_HOME` selects it; paths such as `benchmark:mbpp/test` resolve through its catalog. Raw data, environments, and experiment results stay outside Git.

## Search

The default search imports the pinned official [AFlow controller](https://github.com/FoundationAgents/AFlow/tree/3f457218fc716093fe53f6df8a5d5e6379d66346). It uses native parent sampling, experience filtering, complete validation, and convergence detection. The optimizer proposes the complete child artifact from a selected historical parent and measured search feedback.

- One single-agent root starts the search. Diversity is explored through branches of one search tree.
- Each candidate runs five complete validation repetitions. These are repeated evaluations, not cross-validation folds.
- Default stopping uses upstream top-three mean stability over five comparisons; `maxRounds:null` imposes no extra round cap. Explicit configured limits remain possible.
- The current search does not use legacy MIA acquisition, affected-set inheritance, prefix/agent caches, or progressive elimination.
- Tool execution protection remains enabled. Capabilities such as heterogeneous graphs, new subagents, and tool creation are available to search; their actual use must be established from the selected candidate and execution traces.
- Standard evaluation resets task state. Only committed results from the same candidate and repetition are reused when resuming an interrupted run.

Prepare the upstream checkout at the revision in [the source lock](baselines/sources.lock.json) and install [AFlow's Python dependencies](baselines/requirements-aflow.txt). Python execution requires an available local sandbox image; mathematical grading requires `requirements-benchmarks.txt` in the selected `MFLOW_BENCH_PYTHON` environment. These commands invoke the configured model:

```sh
mkdir -p runs
npm run build
npm run mflow -- search \
  --search ../ReproducedBenchmarks/math/search.jsonl \
  --config configs/aflow-search.json \
  --source ../MFlow-baselines/sources/AFlow \
  --python ../MFlow-baselines/.venv-aflow/bin/python \
  --out runs/math-search \
  --test ../ReproducedBenchmarks/math/test.jsonl
```

`--test` is optional and runs after selection freezes `best.json`. Add `--resume` to the same command after an interruption. Incompatible code, dataset, model, grader, or configuration changes are rejected. Infrastructure failures are recorded separately from wrong answers; unknown provider usage is never represented as zero cost.

## Inference and final evaluation

```sh
npm run mflow -- infer --bundle runs/math-search/best.json --question "What is 7 times 8?"
npm run mflow -- evaluate --bundle runs/math-search/best.json \
  --test ../ReproducedBenchmarks/math/test.jsonl --out runs/math-test
```

The frozen bundle determines the program, profiles/templates, model configuration, and execution settings. The search tree is not consulted during inference. The program can conditionally derive members and route evidence within each task. Reference answers and hidden tests remain on the evaluator side.

The standard protocol does not carry new members or memory between test tasks. The explicit legacy continual protocol has separate state and accounting; do not combine its results with standard evaluation. Historical `legacy-search` remains available for reproducing the original DSL/MIA experiments and is not the default algorithm.

## Repository layout

| Directory | Purpose |
| --- | --- |
| `src/` | Application policies, Ditto integration, search/evaluation entry points |
| `configs/` | Versioned experiment configurations |
| `baselines/` | Upstream source locks and adapters |
| `benchmark-splits/` | Public protocol manifests, ordered IDs, prepare/verify CLI |
| `benchmark-hub/` | Shared local asset manager and official environment bridges |
| `data/*.lock.json` | Pinned upstream and converted dataset identities |
| `scripts/` | Setup, experiment coordination, recovery, and status tools |
| `test/` | Model-free contract and integration tests |
| `runs/` | Ignored local results, frozen bundles, checkpoints, and usage |

Typical search artifacts include `manifest.json`, `controller.json`, per-round strategy/experience files, repeated validation scores, per-task results and usage, optimizer proposals, and `best.json`. Report search cost separately from final test cost, including failed attempts and unknown calls. Historical per-round observation tests are additional experiments and must be disclosed separately.

For the maintained `hb` deployment, run `bash scripts/sync_hb.sh` after code changes and require checksum verification. Credentials, datasets, environments, and experiment results are excluded from source sync.
