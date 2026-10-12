# BFCL R29 fixed-MAS ablations

R29 was explicitly selected by the user after its test result was observed (426/600, 71.00%). This is a supplementary ablation, not a replacement for the search-selected final R31 (419/600). Test feedback does not enter search.

## Definition

R29 starts from one root. Its controller reads BFCL state and creates a fresh turn_runner for an unfinished execution stage. Solver recovery runs only at the inherited error threshold. The library contains solver and turn_runner.

- **Fixed heterogeneous:** root creates one fixed turn_runner and reuses it across public turns. Preserve state reads, completion checks, the 40-stage guard, recovery, role prompts, internal programs, and permissions.
- **Fixed homogeneous:** the same two-member topology, but both use the frozen solver program, node/tool permissions, and reasoning configuration, retaining their role-specific objectives and instructions.

Fixed membership still loops over stateful BFCL turns. Root normally coordinates deterministically and calls its model program only for recovery. This is not a claim that two LLMs independently solve every turn. It compares executor reuse and internal program differences without forcing duplicate world writes.

## Completed results

| Variant | Correct / 600 | Accuracy | Known test tokens | Unknown-usage calls |
| --- | ---: | ---: | ---: | ---: |
| Dynamic R29 | 426 | 71.00% | 209.473355M | 59 |
| Fixed heterogeneous | 419 | 69.83% | 208.127326M | 59 |
| Fixed homogeneous | 410 | 68.33% | 209.717634M | 8 |

All task IDs match. Both fixed runs completed without task-level execution errors. All 600 fixed tasks created exactly one child. Dynamic R29 created 1,356 turn_runner instances (1-8 per task), with no root-only task and no successfully registered generated tool; root solver ran eight times. Supported framework capabilities should not be confused with this observed policy behavior.

## Fairness and cost

Use bfcl-multiturn-family-v1, identical 600 test tasks, verified data hashes and search/test separation. Retain DeepSeek Flash, temperature=0, seed=42, thinking disabled, registry Ditto 0.1.2, and the frozen execution repair configuration. Both variants ran with eight concurrent tasks; BFCL needs no Docker. Evidence is compressed; results, traces, retries, and usage remain auditable.

Known tokens are provider-returned usage. Unknown calls remain separate; chargedTokens includes reservations and is not exact consumption. Test ledgers exclude search and the separate invalid startup pilot. Fixed graphs were not independently searched, and role programs were not optimized on test.

## Reproduce

After npm run build, use `node scripts/prepare_ablations.mjs --source <R29 bundle> --out <new directory> --variant fixed-bfcl-heterogeneous` or fixed-bfcl-homogeneous. The builder rejects controllers that do not match R29's per-stage allocation structure.

Run the same frozen actor's `dist/src/cli.js evaluate --benchmark bfcl --protocol standard --bundle <bundle> --out <new output> --concurrency 8`; add --resume when its manifest exists. Local experiment receipts and ledgers are excluded from Git. The local index is runs/current-experiments.json, localDeepSeek.bfclMFlowR29Ablations.

## Frozen repair loading and invalid startup pilot

Historical tool-history-20261010/install.mjs activates only when a command argument contains `/runs/bfcl/MFlow/`. Final outputs use `<variant>/runs/bfcl/MFlow/test`; logs must confirm both tool-history and storage repairs. A model-free three-turn fixture with the actual frozen bundles verified one child reused across three turns and different role-program inputs. Both programs use the same graph names, so names alone do not establish program identity.

The first startup did not match that repair guard and was stopped/excluded with its ledgers retained. Known costs: heterogeneous 14.502283M, homogeneous 15.438960M; heterogeneous additionally had three unknown-usage calls. These are extra startup costs, not final-test consumption. The experiment's invalid-startup-pilot.json records the incident.
