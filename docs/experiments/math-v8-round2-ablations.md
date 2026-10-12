# MATH v8 Round 2 ablations

Historical frozen-artifact comparison on the same **486** test tasks. These experiments use the previously selected Round 2 strategy; this test set had already been observed and is not a new untouched holdout.

## Conditions

| Method | Execution |
| --- | --- |
| Single | Root solver only; no tools |
| Dynamic MFlow | Root → reviewer; independent/checker conditionally added on missing or disagreeing answers; optional root integration |
| Fixed heterogeneous | Root → reviewer → independent → checker → root integration on every task |
| Fixed homogeneous | Same fixed route; every member uses the independent tool-loop program and arithmetic/Python permissions |

The homogeneous condition retains role-specific prompts while changing internal programs and permissions, including those of root/reviewer. It is therefore not a graph-only intervention. Fixed execution uses four members and five calls.

All conditions preserve DeepSeek temperature 0, global prompts, Ditto 0.1.1, runtime v3.3.1, task membership, scorer/image, and execution guards. Independent receives the original question without the first two answers; reviewer reads root's full derivation; checker reads the first three available derivations; integration reads all four.

## Completed results

| Method | Correct / 486 | Accuracy | Known tokens | Unknown calls |
| --- | ---: | ---: | ---: | ---: |
| Single | 453 | 93.21% | 898,284 | 14 |
| Dynamic MFlow | 469 | 96.50% | 1,943,722 | 26 |
| Fixed heterogeneous | 477 | 98.15% | 9,327,251 | 36 |
| Fixed homogeneous | 478 | 98.35% | 14,711,775 | 38 |

The three added conditions used 24,937,310 known tokens with 88 unknown calls, excluding search. Unknown calls are not zero-cost calls. See [the machine-readable results](math-v8-round2-ablation-results.json).

## Paired changes

| Comparison | Corrections | Harms | Net correct |
| --- | ---: | ---: | ---: |
| Dynamic vs single | 20 | 4 | +16 |
| Fixed heterogeneous vs dynamic | 12 | 4 | +8 |
| Fixed homogeneous vs dynamic | 14 | 5 | +9 |
| Fixed homogeneous vs heterogeneous | 3 | 2 | +1 |

The one-task difference does not establish a general superiority of homogeneous agents. Empty-deficit counts were single=15, dynamic=26, fixed heterogeneous=35, and fixed homogeneous=26.

One homogeneous task was interrupted by invalid arithmetic values. Recovery retained the other 485 predictions and all usage rather than rerunning the full set. The historical engineering suite passed 97 tests. Preparation used the frozen ablation builder and concurrent evaluator, without rerunning search. For exact programs and conditional paths, see [the Round 2 MAS](math-v8-round2-mas.md).
