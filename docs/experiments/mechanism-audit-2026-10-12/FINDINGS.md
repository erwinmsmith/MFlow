# Mechanism audit: findings

This is an offline audit of existing MFlow artifacts, not a new evaluation. It covers 15 indexed lineages, 140 observed rounds, and 17 available test variants across six benchmarks, including the paused HLE run and remote Qwen/MATH. Older incompatible AutomationBench versions and the previous MBPP search remain separate. See the [full report](README.md), [parent-child comparisons](rounds.csv), and [execution counts](test-mechanisms.csv).

## 1. Some search rounds repeat an unchanged strategy

Comparison removes **only the top-level strategy ID**. Frozen candidates take precedence over native strategy exports. The application digest matches all 605 retained pass manifests for the 121 local candidates that have both frozen bundles and manifests. This confirms which candidate was evaluated; it does not prove an unchanged model service, environment, or random sample across rounds.

| Primary lineage | Observed rounds | Distinct payloads, ignoring round ID | Same payload as recorded parent | Same payload as any earlier round |
| --- | ---: | ---: | ---: | ---: |
| DeepSeek MATH v8 | 9 | 8 | 1 | 1 |
| DROP | 33 | 19 | 11 | 14 |
| MBPP, current search | 17 | 15 | 2 | 2 |
| BFCL | 36 | 12 | 24 | 24 |
| AutomationBench v11 | 5 | 4 | 1 | 1 |

Examples:

- **BFCL R21, R29, and R31 have identical payloads**, apart from ID. Their search means are 76.30%, 77.20%, and 77.60%. R31 is a child of R29, whose recorded parent is R25; the actual tree must not be replaced with a sequential chain. These later score changes are not evidence of new structural improvements.
- **DROP R26 repeats R23**: 88.27% versus 87.69% mean F1. R26 also has one terminal execution-error row. The earlier program changes remain real, but this last increase cannot be attributed to another mutation.
- **AutomationBench v11 R3 repeats R2**: 98.90% versus 98.70%. It does not introduce a new agent or a new topology relative to R2.
- **MATH R7 repeats R2**: 97.98% versus 98.32%. MBPP R8 likewise repeats R7 and scores lower.

Repeated evaluation can help estimate variability. Treating each repeated candidate as a newly improved structure, or selecting the largest mean without accounting for repeated selection, overstates the evidence. The audit establishes payload equality, not the optimizer's intent or the cause of duplicate candidates. Their known token expenditure is listed in `candidate-identities.csv`; it is not automatically classified as wasted spending.

## 2. What actually changed during search

The following are observational parent-child comparisons. They are not controlled ablations, and the scores are **search scores**, not test scores. DROP uses mean F1; other rows use accuracy.

| Benchmark / lineage | R1 → best complete mean | Verified changes and limitations |
| --- | --- | --- |
| MATH v8 | 97.98% → 98.32%, R2 | R2 adds `checker` and changes outer orchestration; +0.34 percentage points against R1. Later additions of `decomposer`/`verifier` do not establish a better completed mean. R6 has 595/595 terminal execution errors. |
| DROP | 82.02% → 88.27%, R26 | R5 changes task prompts/profiles and adds `normalizer` (+3.58 points against R2); R7 adds `span_extractor`; R21 removes `reviewer` and changes `solver`/`independent` programs (+1.60 points against R7); R23 changes `calculator`. The best R26 payload already exists at R23. |
| MBPP, current | 83.26% → 83.95%, R7 | R7 adds `oracle_probe` and changes outer control; +0.70 points against R1. R8 repeats this strategy with a lower score. R10 has 330/430 terminal execution errors. The small best-mean increase is not proof of a stable search gain. |
| BFCL | 71.00% → 77.60%, R31 | R2 introduces `turn_runner` and changes control/prompts; R8 changes control and the member program (+2.20 points against R4); R21 changes prompts/root and solver profiles (+1.60 points against R19). Much of the later search repeats existing payloads. |
| AutomationBench v11 | 98.80% → 98.90%, R3 | R2 replaces `independent`/`reviewer` with `verifier` and changes control, scoring 98.70%. R3 repeats R2. R4 has 776/1000 terminal execution errors; R5 is incomplete. This lineage does not establish a structural search improvement. |
| HLE, paused | No complete round | Only 26 outcomes in the first 200-task pass are retained; 22 contain node failures. Do not report the observed subset score as HLE search accuracy. |
| Qwen/MATH | R1: 94.62%; R2 incomplete | R1 has five complete 119-task passes. R2 cannot yet support a complete parent-child score comparison. |

The previous MBPP search and historical AutomationBench versions are included separately in the full report. They must not be pooled with the current lineages to claim one continuous improvement curve. Missing parent records are shown as missing evidence, not inferred independent seeds.

The CSVs group changes into outer MAS control, member library/programs, prompts/profiles, tool definitions/capabilities, and declared routing/spawn/interface changes. Interface labels derived from optimizer descriptions are explicitly marked `declared`. Fault-affected completed tasks are separated from recovered internal node/tool errors. Per-edit branch trigger IDs were not recorded, so the available data cannot establish exactly which edit caused an observed feature to fire.

**BFCL R11 is an additional interface failure that ordinary error counters miss.** Its `turn_runner` compares the outer `bfcl_call`/`bfcl_respond` request names against the inner benchmark function schemas, then issues clarification responses. All 1,000 outcomes score zero, while the trace records 5,040 successful state calls and 4,040 successful response calls, with no `bfcl_call`. There are no recorded terminal exceptions or node failures. Static code and observed calls support marking this as a reviewed interface fault; it is excluded from clean mutation-effect comparisons. The reviewed evidence is preserved in `reviewed-faults.json`.

## 3. Which mechanisms actually ran in test

These are full retained test sets. A root-only episode has one initial member and no SPAWN event. Spawn events count children created, not necessarily children successfully executed. Tool counts below refer **only to autonomously generated tools**, excluding ordinary benchmark and built-in tools.

| Frozen candidate | Test tasks | Root-only episodes | Spawn events | Spawn events without a template ID | Generated tools registered | Successful generated-tool calls | Successful cross-agent calls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| MATH R2 | 486 | 0 | 525 | 0 | Unknown | Unknown | Unknown |
| DROP R26 | 800 | 450 | 725 | 20 | 2 | 62 | 0 |
| MBPP R7 | 341 | 13 | 1,042 | 87 | 0 | 0 | 0 |
| BFCL R29, supplementary | 600 | 0 | 1,356 | 0 | 0 | 0 | 0 |
| BFCL R31, search-selected | 600 | 0 | 1,326 | 0 | 0 | 0 | 0 |
| AutomationBench v11 R3, supplementary | 600 | 494 | 128 | 21 | 1 | 13 | 1 |

There is **actual dynamic spawning**, with meaningful differences between tasks and benchmarks:

- MATH always spawns `reviewer` (486 events); `independent` appears 28 times and `checker` 11 times.
- DROP spawns `calculator` 269 times, `normalizer` 156, `solver` 134, `independent` 98, `span_extractor` 48, and members without a template ID 20 times.
- MBPP spawns `oracle_probe` 309 times, `solver` 305, `independent` 201, `reviewer` 140, and members without a template ID 87 times.
- BFCL R29's 1,356 spawn events all use `turn_runner`. The test shows task-dependent member counts, not a diverse library of specialist child types.
- AutomationBench v11 R3 spawns `verifier` 94 times, `solver` 13 times, and members without a template ID 21 times.

No recursive child-of-child spawn episode is recorded in these selected/supplementary test sets. Members without a template ID demonstrate use of non-template profiles; they do **not** by themselves prove a novel internal graph. Likewise, a runtime-generated program binding is not evidence that a new specialist agent was created.

Typed node/dependency fingerprints and evidence-edge counts are exported. They ignore node names to avoid counting renames as new structures. Distinct executed shapes can result from control flow or coordinator/executor differences, including in a fixed homogeneous setup; they must not be called distinct learned semantic strategies. Cross-agent node edges also miss information passed directly as strings/messages.

## 4. Tool behavior in search versus test

Counts below sum retained task × pass observations across the whole named search lineage, including repeated candidates and partial rounds. They are not counts of globally unique tools.

| Search lineage | Generated registrations | Successful generated-tool calls | Successful calls by a different agent |
| --- | ---: | ---: | ---: |
| DROP | 16 | 16 | 0 |
| MBPP, current | 6 | 8 | 1 |
| BFCL | 42 | 11 | 8 |
| AutomationBench v11 | 0 | 0 | 0 |
| MATH / HLE legacy fields | Unknown | Unknown | Unknown |

Generation during search does not guarantee use by the selected policy during test. MBPP and BFCL provide direct examples. AutomationBench v11 shows the reverse: one generated tool appears during the frozen R3 test despite none being registered in the retained search observations.

The existing fixed-MAS test variants are also audited. AutomationBench's heterogeneous variant has 28 generated registrations, 159 successful calls, and 18 cross-agent calls; its homogeneous variant has 12, 63, and 12 respectively. This is evidence that creation/reuse can execute, not proof that it improves task accuracy. Their task-ID sets match the dynamic test set. Corresponding within-benchmark MATH, DROP, MBPP, and BFCL variants also have matching task-ID sets.

## 5. Cost and evidence boundaries

- No model calls, searches, test reruns, or runtime changes were made for this audit.
- Curves include known retained task and optimizer usage, including faults and partial work. Unknown usage remains unknown; cached input tokens remain tokens, not equivalent cash charges.
- For MATH v8, completed R1–R8 account for 58.99M known retained tokens, while unfinished R9 adds 197.49M. The full-lineage curve therefore has a much larger denominator than the historical approximately 59.08M completed-search table. These accounting scopes must not be silently substituted for one another.
- Scores are stored task outcomes recomputed into matched parent-child means. There is no new grading or new test-based selection. BFCL R29 remains a supplementary test-observed choice; R31 is the search-selected candidate.
- Raw datasets, answers, prompts, generated responses, private run paths, and optimizer descriptions are excluded from the public report. Remote active records are a non-atomic read snapshot.

## 6. Highest-value next steps without another full search

1. Before any future paid run, distinguish unchanged-candidate reevaluation from mutation and make that distinction visible to selection/convergence and reporting. Preserve repeated observations rather than relabeling them as new structures.
2. Analyze uncertainty on existing matched task records and report the earliest occurrence of the selected payload alongside its repeated evaluations. Do not count a higher repeated mean as a newly discovered MAS.
3. Treat tool creation and non-template spawning as supported mechanisms with benchmark-specific observed frequency. Do not claim a causal benefit or deep, broadly heterogeneous recursive MAS from these logs alone.

No experiment or search implementation was changed as part of these recommendations.
