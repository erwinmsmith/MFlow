# DROP R26 fixed heterogeneous / homogeneous MAS

## Frozen source and comparison

Use the search-selected `s26` bundle at
`../experiments/deepseek-drop-mbpp-mflow-20261008/MFlow/runs/drop/MFlow/search/best.json`.
The original dynamic policy achieved 86.91% F1 (661 exact-correct / 800) on the
complete pinned AFlow DROP test. Selection used search scores, not test results.

R26 contains a dynamic control program plus five templates, not a single fixed
population graph. These fixed comparisons use the entire frozen template library
in a prescribed route; the route is an ablation, not a newly searched static optimum:

1. `root` / `solver` solves the task.
2. `independent` solves from the original task without other candidates.
3. `calculator` runs its inherited numeric role from the original task.
4. `span_extractor` runs its inherited extraction role from the original task.
5. `root` integrates the four labelled candidate outputs using the frozen
   `integrate` prompt.
6. `normalizer` receives the integrated answer string and returns the final answer.

Both variants always invoke this same route, including when candidates agree.
The route starts with root and deterministically instantiates the four other
members. It does not call the dynamic factory or search a new agent program.
Task-local tool creation remains available through inherited permissions.

| Variant | Internal execution |
| --- | --- |
| `fixed-drop-heterogeneous` | Preserve all five R26 profiles and programs: solver/calculator tool loops, independent CoT trajectory, span-extractor self-consistency trajectory, deterministic normalizer |
| `fixed-drop-homogeneous` | Every template and root receives the frozen solver program, node permissions, reasoning mode and tool permissions; preserve role objectives, private instructions, output contracts and global prompts |

Homogeneous normalization therefore uses the solver's model/tool loop instead of
the deterministic normalizer. This comparison changes both internal graph and
execution capability; it does not isolate graph topology alone. All specialisms
run even for questions where a particular role is unnecessary, as expected for
the fixed-library ablation.

Preflight with the actual frozen templates found a serialization defect:
`independent` and `span_extractor` use `String(r.result)` for TRAJECTORY output,
but Ditto returns a Message `{role, content}`. This silently publishes
`[object Object]`. The builder corrects these two expressions to read
`r.result.content` before applying the variant transformation and records source
and prepared program hashes. Profiles, prompts, trajectory strategies and node
configuration stay inherited. The old dynamic score is not retroactively changed;
the comparison must disclose this interface repair and cannot attribute every
score difference solely to dynamic versus fixed routing.

## Execution and accounting

- DeepSeek Flash, temperature 0, seed 42, thinking disabled, inherited model
  output setting and execution protections; 8 concurrent questions per variant.
- Same 800 test tasks, order, F1/exact scorer and documented source-split prompt
  overlaps as the completed dynamic run. No test question/reference is read by
  bundle preparation. No search or per-round tests for these variants.
- Execute with the original DROP actor snapshot and its recorded Docker,
  provider-progress and finite-program guidance repairs. Preserve its compatible
  frozen Ditto guide and package 0.1.2; do not migrate the R26 bundle to the newer
  MBPP runtime/guide. The ablation builder only changes application bundle data.
- Keep separate manifests, task results and `task-usage` ledgers per variant.
  Include all attempts and recovery calls in test token cost. Report known input,
  output and cached input, and unknown-usage calls separately. Search cost is
  inherited background cost, not another charge for these test-only variants.
- Resume only missing work under the same manifest; preserve wrong completed
  answers. Compact execution evidence and prune transient request diagnostics
  using the existing experiment utilities. No new Docker images are required.

Prepare each variant into a separate output directory with:

```bash
node scripts/prepare_ablations.mjs --source SOURCE_BUNDLE --out VARIANT_DIRECTORY --variant fixed-drop-heterogeneous
node scripts/prepare_ablations.mjs --source SOURCE_BUNDLE --out OTHER_VARIANT_DIRECTORY --variant fixed-drop-homogeneous
```

From the recorded original actor environment, run each prepared bundle using
`node --env-file-if-exists=.env dist/src/cli.js evaluate --benchmark drop --bundle BUNDLE --out TEST_DIRECTORY --concurrency 8`.
For interruption recovery add `--resume`. Operational launcher paths, hashes and
process IDs are recorded in `runs/current-experiments.json` and the independent
experiment directory. Existing MBPP experiments remain untouched.

Offline regression tests verify the complete call route, isolated specialist
inputs, integration/normalization evidence, homogeneous capabilities, immutable
source prompts, hidden-label exclusion and token accounting. Scripted-provider
tests are execution-contract checks, not benchmark performance evidence.
