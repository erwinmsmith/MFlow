# MATH partial test snapshot, 2026-09-27

Snapshot at `2026-09-27T11:53:40Z`: **396/486** test tasks completed. These rates apply only to the completed subset. See [the completed report](math-test-complete-2026-09-27.md) for the eventual result.

| Within-trace stage | Correct / completed | Rate |
| --- | ---: | ---: |
| Root | 324 / 396 | 81.82% |
| Before first child | 336 / 396 | 84.85% |
| Final | 355 / 396 | 89.65% |

Post-derivation changes included 21 corrections and two harms. End-to-end changes included 36 corrections and five harms. These stage comparisons are not independent ablation experiments.

394 tasks spawned 409 children. Known usage was 3,436,978 tokens, approximately 8,679 per completed task. There were 64 historical token-stop markers and 32 cases without post-spawn integration.

At this snapshot, validation was AFlow 114/119 (95.80%) versus MFlow 106/119 (89.08%); this did not establish a MFlow quality improvement. Offline analysis did not change prompts or launch paid calls, and the test artifact remained frozen. An AFlow serialization repair reused all 119 initial validation results. Ordinary AutoAgents parse failures were retained rather than selectively removed from its score.
