# Shared benchmark hub

This directory versions the asset manager. The installed manager runs independently of MFlow and uses the Python 3.9+ standard library. Preparation and official grading environments can require additional dependencies.

The default external directory is `../Benchmarks`; override it with `BENCHMARK_HOME` or `--root`. To reproduce data on a new machine, start with the [public split package](../benchmark-splits/README.md). To consolidate existing local downloads:

```sh
python3 benchmark-hub/bench.py install
python3 ../Benchmarks/bench.py import-local --mflow-data data/benchmarks --official-data ../Ditto/benchmarks/data
python3 ../Benchmarks/bench.py list
python3 ../Benchmarks/bench.py verify
python3 ../Benchmarks/bench.py path math --split search
```

Use paths to your existing downloads in `import-local`. The importer validates hashes and source revisions before moving same-volume assets and preserving the original paths as symlinks. Reruns do not silently establish a new baseline for changed data. Reading an existing dataset directory from another project does not import that project's runtime.

Keep immutable inputs in `collections/`, prepared protocols in `views/`, environments in `environments/`, and generated state/caches in `state/`. Keep experiment results in their original projects. Do not commit datasets, credentials, or gated GAIA/HLE files.

## Protocols and execution

The [shared benchmark guide](../docs/shared-benchmarks.md) lists support and scoring details. The [public catalog](../benchmark-splits/catalog.json) fixes exact ordered membership and hashes for 11 prepared protocols:

- Five AFlow subsets preserve the pinned upstream validation/test split.
- HumanEval+ inherits AFlow HumanEval membership with EvalPlus questions and tests.
- BFCL uses a custom 200/600 family-isolated four-category multi-turn split. A separate native 800-conversation SingleLLM run is not this split.
- AutomationBench uses 200 public simple tasks for search and 600 public domain tasks for test.
- HLE has separate text-only/full test views and a custom stratified 200/2300 holdout.
- GAIA and tau3 currently manage official assets only; no MFlow split or execution support is implied.

All compared methods must share task membership, source revisions, tool environments, and graders. Reference answers, expected actions, and simulator-private goals remain on their designated evaluation/simulation side. Search, actor, judge, simulator, and retrieval costs must be identifiable in reports.

For installed extra preparation commands and scoring setup, see the shared guide. For HumanEval+:

```sh
docker build -f ../Benchmarks/Dockerfile.evalplus -t mflow-evalplus:0.1.10 \
  ../Benchmarks/collections/official-20260930/HumanEval+
```

The official EvalPlus modules supply the oracle, tolerances, and base/plus checks. Generated code executes through the published Ditto Sandbox in a restricted container. Both suites must pass. Record the immutable image ID; infrastructure failures are not wrong answers.
