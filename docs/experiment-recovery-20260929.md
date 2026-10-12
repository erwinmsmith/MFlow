# Experiment recovery, 2026-09-29

Historical incident record. Recovery preserved frozen configurations, completed predictions, and original usage; it did not use test outcomes to revise prompts or select candidates.

## MFlow v8

Run `v8-20260929-03` encountered a terminated provider stream. Recovery required the same published package, frozen code/configuration/model, and Docker image before `--resume`. It preserved 356 committed evaluations and continued the remaining task of Round 1's third validation pass.

## AFlow final test

Only 15 candidates had valid completed evaluations. Rounds 16–21 contained technical `score=None` failures. At 18:12 the controller loop had ended and Round 12 was frozen, with validation 118/119. This was not a successful 21-round convergence result.

The previous test file contained 290 rows:

- 250 completed predictions: 244 correct and six wrong.
- 40 `TransportFailure` rows incorrectly recorded as zero scores.

Recovery archived the original 290 rows, hashes, and fault records. It retained all 250 valid predictions, including the six wrong ones. It rescheduled the 40 infrastructure failures and 196 unseen tasks: 236 outstanding tasks in total. Earlier usage remained in cost accounting.

`scripts/resume_aflow_test.py` accepts the frozen artifact, verifies manifest/workflow/task identities, and does not optimize the workflow. Provider transport failures propagate outside ordinary answer retries/grading instead of becoming wrong answers. The local bridge on port 8197 was required. Recovery status and the final native-adapter summary provide progress evidence.

These repairs concern execution and accounting. They do not change AFlow's search algorithm or retroactively remove the cost of failed calls.
