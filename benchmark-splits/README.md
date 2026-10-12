# Reproducible benchmark splits

Release: **`mflow-splits-v1`**. This package publishes the exact task membership and order used by MFlow's prepared protocols. A seed alone is insufficient: upstream revisions, filtering, grouping, and conversion can change the resulting split.

No dataset questions, answers, attachments, API keys, or experiment traces are included. Obtain source data from the publisher under its access conditions. Metadata inspection and verification require only Python 3.9+, with no MFlow runtime or model account.

## Published protocols

| Benchmark | Protocol | Search | Test | Scope |
| --- | --- | ---: | ---: | --- |
| DROP | `aflow-fixed-v1` | 200 | 800 | Pinned AFlow subset; known overlaps below |
| HumanEval | `aflow-fixed-v1` | 33 | 131 | Pinned AFlow membership |
| MBPP | `aflow-fixed-v1` | 86 | 341 | Pinned AFlow subset |
| GSM8K | `aflow-fixed-v1` | 264 | 1,055 | Pinned AFlow subset |
| MATH | `aflow-fixed-v1` | 119 | 486 | Pinned AFlow subset |
| HumanEval+ | `humaneval-plus-aflow-v1` | 33 | 131 | HumanEval membership, EvalPlus questions/tests |
| AutomationBench | `automationbench-public-simple-v1` | 200 | 600 | Simple search; six public test domains |
| BFCL | `bfcl-multiturn-family-v1` | 200 | 600 | Four multi-turn categories; task families isolated |
| HLE | `hle-text-test-v1` | — | 2,158 | Text-only test view |
| HLE | `hle-full-test-v1` | — | 2,500 | Full test view, including 342 image tasks |
| HLE | `hle-full-holdout-v1` | 200 | 2,300 | Custom stratified holdout; 28/314 image tasks |

GAIA and tau3 have asset management only; this release publishes no MFlow split for them. The HLE views overlap by design: do not search on the holdout search set and then report either full test view as untouched test data. HumanEval and HumanEval+ are the same underlying task family.

## Inspect and verify

Run from the repository root, ideally at the release tag or an explicitly recorded Git commit:

```sh
python3 benchmark-splits/splits.py list
python3 benchmark-splits/splits.py verify --benchmark bfcl
python3 benchmark-splits/splits.py verify --benchmark bfcl --data /path/to/bfcl-view
python3 benchmark-splits/splits.py verify --benchmark hle --protocol hle-full-holdout-v1
```

Without `--data`, verification checks the published manifest/ID/metadata hashes, counts, order, and ID/family separation. With `--data`, it additionally verifies every JSONL record, including evaluator-only fields, against canonical content hashes. Harmless JSON whitespace changes are accepted by this standalone verifier. MFlow's existing runtime additionally enforces the original byte-level file hashes; use the preparation command to generate its exact format.

A changed ID, task order, question, answer, group, or grading reference fails verification. Hash verification establishes agreement with the release; record the trusted release commit/catalog hash as well.

## Prepare from pinned sources

Preparation validates source identity, reconstructs the published membership, checks all records before writing, and refuses an existing output directory. It does not resample tasks or install evaluation environments.

### AFlow subsets

```sh
python3 benchmark-splits/splits.py prepare --benchmark math --download --out ../ReproducedBenchmarks/math
python3 benchmark-splits/splits.py verify --benchmark math --data ../ReproducedBenchmarks/math
```

Replace `math` with `drop`, `humaneval`, `mbpp`, or `gsm8k`. `--download` explicitly fetches the locked archive. For offline preparation, replace it with `--source /path/to/aflow_data.tar.gz`. The source is AFlow commit `3f457218fc716093fe53f6df8a5d5e6379d66346`; all five protocols preserve validation → search and test → test, including original ordering. No extra confirmation split is introduced.

### BFCL

```sh
python3 benchmark-splits/splits.py prepare --benchmark bfcl --download --out ../ReproducedBenchmarks/bfcl
```

Alternatively pass `--source /path/to/gorilla` at commit `6ea57973c7a6097fd7c5915698c54c17c5b1b6c8`. Git and the relevant source-file hashes are checked. The four categories are `multi_turn_base`, `multi_turn_miss_param`, `multi_turn_miss_func`, and `multi_turn_long_context`, with 50 search and 150 test conversations each.

The split groups shared numeric task families and identical normalized initial public questions, using the pinned seed-42 construction recorded in the manifest. Published IDs are authoritative. Split whole conversations, never individual turns. This is a custom four-category development protocol, not the entire BFCL leaderboard. The independent native 800-task SingleLLM evaluation is a different protocol.

### AutomationBench

Export tasks using the pinned official environment:

```sh
git clone https://github.com/zapier/AutomationBench.git ../AutomationBench-source
git -C ../AutomationBench-source checkout --detach 4a8e1061254004d9dac807054eed33fad7d1ff14
(cd ../AutomationBench-source && uv sync --frozen)
```

Use the official source root as the working directory and its Python environment to run MFlow's export bridge:

```sh
MFLOW_REPO="$PWD"
(cd ../AutomationBench-source && .venv/bin/python "$MFLOW_REPO/benchmark-hub/automation_bridge.py" --export ../automation-tasks.jsonl)
python3 benchmark-splits/splits.py prepare --benchmark automationbench \
  --source ../automation-tasks.jsonl --out ../ReproducedBenchmarks/automationbench
```

The export builds official tasks without model calls. The 200 simple tasks form search; 100 tasks from each of sales, marketing, operations, support, finance, and HR form test. This is a public cross-domain development protocol, not an official train/test split or the private leaderboard. API schemas, worlds, and assertions must also use the pinned official environment during evaluation.

### HumanEval+

Obtain the official `HumanEvalPlus-v0.1.10.jsonl.gz` release and check the source hash in `data/humaneval-plus.lock.json`:

```sh
python3 benchmark-splits/splits.py prepare --benchmark humaneval_plus \
  --source /path/to/HumanEvalPlus-v0.1.10.jsonl.gz --out ../ReproducedBenchmarks/humaneval_plus
```

Membership and order follow AFlow HumanEval. Prompts and base/plus tests come from EvalPlus. The evaluator revision is separately locked. Canonical solutions, contracts, and hidden tests must not be added to actor input.

### HLE

Use an authorized download of `cais/hle` at dataset revision `5a81a4c7271a2a2a312b9a690f0c2fde837e4c29`. Download `data/test-00000-of-00001.parquet` through the account that has accepted access conditions; do not redistribute it in this repository. Parquet preparation additionally requires `pyarrow` in the selected Python environment.

```sh
python3 benchmark-splits/splits.py prepare --benchmark hle --protocol hle-full-holdout-v1 \
  --source /path/to/test-00000-of-00001.parquet --out ../ReproducedBenchmarks/hle-holdout
```

Choose `hle-text-test-v1` or `hle-full-test-v1` explicitly for the other views. The holdout uses category × answer type × image presence strata, largest-remainder allocation, and SHA-256 ordering of `42:taskId`. Images are reconstructed under the output directory; set `BENCHMARK_HOME` to that output when resolving its relative image paths. Preparing metadata is not a claim of model vision support or official judge equivalence.

## How to reuse and report the protocol

1. Pin this repository's release tag/commit, upstream revisions, and the protocol name.
2. Prepare or verify the data using the commands above.
3. Give every method the same ordered test IDs and evaluation environment. Record model options, prompts, scorer/container identity, and any repairs.
4. Use search data for mutation, candidate evaluation, and selection. Freeze the selected artifact before final test. Five validation repetitions are repeated evaluations of the same search set, not five folds.
5. Report search cost and final test cost separately, including retries and unknown usage. Test-driven model/round selection is a separate exploratory result, not untouched final evaluation.

Suggested methods text:

> We use MFlow split release `mflow-splits-v1` at commit `<commit>`, protocol `<protocol>`, and its published ordered task IDs. Prepared records were verified against the release manifest. All methods use the same held-out test membership and pinned grader. Search uses only the published search partition; final evaluation uses a frozen selected artifact.

Disclose protocol-specific exceptions. In particular, AFlow DROP contains **five locked duplicate prompt pairs across search/test and shared passages**. The IDs and prompt hashes are recorded in its manifest. These exceptions are preserved for reproducibility; other overlaps are rejected. This release does not retroactively make earlier test-informed decisions independent.

## Files and maintenance

Each protocol contains `manifest.json`, `search.ids.json` when applicable, `test.ids.json`, and `tasks.json`. The latter contains IDs, split roles, hashes, and optional group/category metadata only. The catalog hashes each manifest, which in turn hashes the lists and per-task metadata. Repository data locks retain the raw source and converted-file identities.

`publish.py --root /path/to/Benchmarks` is a maintainer export from already verified local views. It refuses content that differs from committed locks. Do not silently replace v1 membership: changes to tasks, grouping, preprocessing, or source revisions require a new protocol/release and documented comparison impact. Keep the release tag immutable.
