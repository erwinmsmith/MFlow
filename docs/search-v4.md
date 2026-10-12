# Search v4: the upstream AFlow controller

Historical protocol introduced on 2026-09-28. [V5](search-v5.md) later added full heterogeneous organization inheritance; [v6](search-v6.md) introduced native graph/loop programs.

## Control source

`scripts/aflow_strategy.py` imports the official optimizer from `FoundationAgents/AFlow@3f457218fc716093fe53f6df8a5d5e6379d66346`, verified by `baselines/sources.lock.json`:

- `Optimizer`: initialization and native optimization iterations.
- `DataUtils`: repeated-score means, top-four parent candidates, exponential weights, and 0.3 uniform exploration.
- `ExperienceUtils`: parent-specific successful/failed edits, duplicate modifications, and feedback.
- `GraphUtils`: complete-artifact optimization prompts, a focused change, guidance of at most five changed lines, and up to three failure examples.
- `EvaluationUtils`: complete repeated evaluations and individual score records.
- `ConvergenceUtils`: top-three means, z=0, and five stable comparisons.

The adapter substitutes policy JSON for Python graph/prompt files and Ditto for model execution. It does not reimplement an approximate sampler or convergence detector in TypeScript. Representation-specific prompt changes are disclosed; prompts are not claimed to be verbatim upstream copies.

Five validation repetitions are an explicit configuration choice. The upstream constructor defaults to five, but its CLI defaults to one. The historical baseline at this stage used one repetition; that comparison was not compute matched.

## Removed shortcuts and runtime boundary

The default path does not use the typed mutation grammar, MIA acquisition/posteriors, affected-set reuse, prefix/agent caches, progressive racing, or lower-cost tie promotion. Every candidate and repetition runs the full validation set.

V4 proposed a complete `program`, five prompt roles (`agent`, `factory`, `review`, `integrate`, `retrieve`), and `modification`. Conditional control could inspect tasks, member states, deficits, artifacts, edges, and tool events, then request an organization action. Factory-generated profiles remained open-ended. Control code had no direct model, network, or file API.

The published Ditto 0.1.1 package supplied RegisteredTool, Interaction Worker, Sandbox, and the local sandbox executor. Python tools ran in fresh containers without network, host mounts, credentials, or persistent state. Image IDs were frozen. Standard-library Python was not claimed equivalent to AFlow's complete host environment. A changed image requires a separate run.

No additional experiment token, step, member, or depth quota was imposed. Historical guards included a 100ms synchronous control deadline, 30-second isolated Python execution, the provider's 393216 output allowance, and Node's supported request deadline. Later versions revise these implementation details.

## Running and resuming

Use the pinned AFlow checkout and Python environment; `--source` and `--python` override their locations. Code, dependencies, grader, source, configuration, dataset, and image are frozen in manifests.

```sh
npm run build
MFLOW_BENCH_PYTHON=.benchmark-venv/bin/python npm run mflow -- search \
  --search data/benchmarks/math/search.jsonl \
  --config configs/aflow-search.json \
  --out runs/math-aflow-v4 \
  --test data/benchmarks/math/test.jsonl
```

The optional test runs only after selection and freezing. Historical concurrency was 50, with separate providers, ledgers, and task-local states. `--resume` skips only committed tasks of the same candidate and repetition; candidates/repetitions never share model results. Settled usage and unknown interrupted reservations remain recorded. V2/v3 bundles require their original runtime.

The historical evaluator used five attempts with one-second waits for ordinary model execution failures. Invalid candidate loading follows the upstream round-error path. Later infrastructure-failure handling must be read with the corresponding frozen revision.

## Convergence and contract checks

`maxRounds:null` continues until upstream `check_convergence(top_k=3)` succeeds. With z=0 and five comparisons, any change to the top-three mean restarts the stable window. This does not guarantee a global optimum. Finish interrupted validation repetitions before deciding convergence. Explicit limits report `max_rounds`; infrastructure faults are not convergence.

A real proposal returned an arrow function where a function body was expected, causing repeated undefined results. The repair normalizes equivalent function representations and checks the interface on label-free fixtures: return object, legal action, valid references, and DERIVE request shape. Invalid proposals receive contract-only model repair. A runtime contract fault stops new scheduling, drains in-flight tasks, and removes partial candidate repetitions from the upstream score table while retaining original logs and costs. It does not invent zero scores or select actions using fixture correctness.
