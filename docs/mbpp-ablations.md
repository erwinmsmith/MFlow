# MBPP fixed MAS ablations

Freeze the MFlow bundle selected by search before preparing either variant. Both
variants use the same model settings, task split, grading, prompts and safety
limits as the dynamic run. Test feedback must not affect search or preparation.

The prescribed fixed route is `oracle_probe → root solver → independent → reviewer
→ root integration`. It uses all four roles from the Round 7 library. This is an
ablation topology, not a separately searched optimal static graph. The independent
solver receives the contract but no other candidate; the reviewer receives both
candidates, and the final root receives their outputs and the review. All stages
run even when candidates agree. Internal tool loops remain enabled as specified
by each bound program, including the frozen tool-creation capability.

- `fixed-mbpp-heterogeneous`: inherit each role's frozen graph/loop and capability
  configuration unchanged.
- `fixed-mbpp-homogeneous`: use the frozen solver graph/loop, node permissions,
  reasoning mode and tool permissions for every member. Preserve role objectives,
  private instructions and output contracts, including the probe's JSON contract.

Prepare each variant with `node scripts/prepare_ablations.mjs --source <best.json>
--out <new-directory> --variant <variant>`, then use the standard `evaluate
--benchmark mbpp --bundle <prepared-best.json> --out <test-directory> --concurrency
8` command. Resume with the identical bundle and `--resume`.

Report all 341 held-out task IDs, correct count, accuracy, known input/output token
totals (cached input is already included), and unknown usage separately. Include
retries in cost. These variants have no additional search cost; do not duplicate
the source MFlow search cost in their test totals. Preserve the bundle hash,
source revision, runtime repair receipts and test-data hash with each run.
