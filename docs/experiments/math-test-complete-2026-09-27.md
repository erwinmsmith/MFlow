# MATH completed test, 2026-09-27

Historical `s4v2` frozen-policy result on the 486-task AFlow test split. Task IDs and order were verified. Two output-format interruptions resumed the same frozen artifact.

## Final score and cost

| Metric | Result |
| --- | ---: |
| Correct / total | 431 / 486 |
| Accuracy | 88.68% |
| Known tokens, all attempts | 4,235,308 |
| Known tokens, completed executions | 4,212,610 |
| Known failed/recovery tokens | 22,698 |

## Within-trace stages

| Stage | Correct | Rate |
| --- | ---: | ---: |
| Root answer | 394 | 81.07% |
| Before first child | 410 | 84.36% |
| Final answer | 431 | 88.68% |

Review corrected 19 tasks and harmed three. Later derivation corrected 24 and harmed three, for a net gain of 21 over the pre-child stage. End-to-end, 43 corrections and six harms yielded a net gain of 37 over root.

These are stages of the same recorded executions, not independently run ablation groups. Derivation occurred on 483/486 tasks, producing 500 children. On 41 tasks, no further root completion followed spawning. The old `token_stop` field appeared 78 times and was not sufficiently specific to identify one cause.

## Contemporaneous search snapshot

At `2026-09-27T13:18:22Z`, v3 search scores were s0=94/119, s1=99/119, s2=107/119. Relative to s1, s2 corrected ten and harmed two; 114 tasks spawned, with two lacking subsequent integration. AFlow R1 and R2 each scored 116/119, and R3 was running. Other baseline scores were incomplete.

See [the historical search artifact](math-search-v2-2026-09-27.json). Later results use different frozen versions and must not overwrite this record.
