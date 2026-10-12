# Pinned AFlow data protocol

## Source and mapping

Source: `FoundationAgents/AFlow@3f457218fc716093fe53f6df8a5d5e6379d66346`, the release referenced by its data/download_data.py. Archive SHA-256: `7089a373c27184ae1b67e322f8276642dab246359052989b03a27f48251ae053`. Source and converted file hashes are fixed in [data/aflow.lock.json](../data/aflow.lock.json). Public task membership is now in [benchmark-splits](../benchmark-splits/README.md).

Upstream evaluator.py reads the entire validate file when is_test=False and the entire test file when True, with va_list=None. Validation repetitions reuse that same set; they are not additional splits or cross-validation folds.

| Benchmark | validate -> search | test -> test | Total |
| --- | ---: | ---: | ---: |
| DROP | 200 | 800 | 1000 |
| HumanEval | 33 | 131 | 164 |
| MBPP | 86 | 341 | 427 |
| GSM8K | 264 | 1055 | 1319 |
| MATH | 119 | 486 | 605 |

These are actual released subsets, not the original benchmark train/test counts or a recomputed 20/80 split. Preserve membership, order, and duplicates. Search seed changes do not change the data.

## Use of each split

Search, candidate comparisons, and selection use full search/validate only. Default AFlow-controlled search evaluates each candidate from scratch for every configured repetition. It does not use prefix reuse, progressive elimination, or cached agent results. Those mechanisms are historical legacy-search features.

There is no separate confirmation set in this protocol. Freeze best.json before final evaluation on all test tasks. Each standard task resets organization state; only public task inputs enter agents. Answers, solutions, and hidden assertions belong to scoring. `infer --question` operates on a new question. Continual organization is a separately named protocol, not standard evaluation.

Files carry aflowSplit=validate/test. Full-file hashes prevent silently cropped, edited, or concatenated datasets. Purpose checks reject test as search, validate as final test, and resplitting through prepare.

## Conversion boundary

| Benchmark | Agent input | Grader-only material |
| --- | --- | --- |
| DROP | context | ref_text; alternative references separated by `|` |
| GSM8K | question | answer; no cot added to the prompt |
| MATH | problem | solution |
| HumanEval | prompt | test and entry point; canonical_solution is not imported |
| MBPP | prompt | test/test_imports; no hidden assertions or reference code appended |

IDs retain their source identity with a benchmark namespace. MATH lacks source IDs and uses SHA-256(problem). Source order is preserved. Upstream public_test helper pools are not additional evaluation splits and are not enabled. HotpotQA members inside the archive are not extracted or prepared.

## Known DROP overlap

The upstream question-level split shares 120 passage texts. It also includes five normalized duplicate question pairs; test has eight additional duplicate-prompt records internally:

| Search ID | Test ID |
| --- | --- |
| drop:563 | drop:5145 |
| drop:5872 | drop:7202 |
| drop:8540 | drop:4560 |
| drop:3024 | drop:871 |
| drop:131 | drop:3879 |

Preserving AFlow membership means retaining them. This is not a fully disjoint passage-level holdout. Only these pinned ID/prompt-hash pairs are allowed; unknown prompt/ID/group overlaps fail. Evaluation reports knownSourceOverlaps. The other four AFlow benchmarks had no normalized prompt overlap across validate/test in the local audit. This does not establish absence of semantic near-duplicates or pretraining contamination.

## Scoring and reproduction

Matching inputs and labels does not imply identical execution/scoring environments. GSM8K extracts the last numeric answer with tolerance. DROP uses maximum alternative token F1, optimizes mean F1 in current search, and separately reports F1=1 accuracy. Legacy utility was binary. HumanEval/MBPP execute original assertions through Ditto Sandbox in isolated Docker; preprocessing/timeouts differ from AFlow's host-thread evaluator. MATH uses math-verify rather than AFlow's original equivalence implementation.

```sh
python3 benchmark-splits/splits.py prepare --benchmark math --download --out ../ReproducedBenchmarks/math
python3 benchmark-splits/splits.py verify --benchmark math --data ../ReproducedBenchmarks/math
```

No models are called for preparation/verification. Evaluation additionally requires the documented grader/container dependencies. A budget stop never reduces the dataset or promotes a partial candidate.

Historical verification on 2026-09-27: all ten converted files and 3,515 records matched source order, inputs, and labels/assertions; only the five pinned DROP overlaps were allowed. Node tests passed 32/32, including Docker scoring. Gold-answer wiring checks passed DROP 1000/1000, GSM8K 1319/1319, and sampled MATH 4/4, HumanEval 7/7, MBPP 6/6. These were data/grader tests, not model scores. Older 64/16 samples and original full-official-test results remain separate archived protocols.
