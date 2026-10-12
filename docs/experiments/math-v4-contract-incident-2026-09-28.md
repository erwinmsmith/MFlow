# MATH v4 candidate-contract incident

Historical snapshot: 2026-09-28, 16:31 Asia/Shanghai.

Round 1's five complete passes scored 98, 99, 97, 104, and 99 out of 119: **497/595 = 83.5294%**. Its valid STOP-returning artifact was retained.

The first Round 2 candidate generated 594/595 attempted rows. Of these, 575 failed with undefined/invalid JSON output, and the other 19 also scored zero. Known charged usage was **11,245,304 tokens**, including retries, with additional interrupted usage unknown. This was an invalid execution experiment, not a meaningful zero-quality candidate score.

## Cause and repair

The generated full arrow function was wrapped as a function body and therefore returned undefined. Further contract mismatches included CONTINUE carrying a DERIVE request and invalid lowercase deficit fields.

The invalid run was stopped. Raw logs and costs were preserved, and invalid Round 2 score-table entries were removed. Round 1 was not discarded. Recovery normalized equivalent function/body representations and checked return types, legal actions, IDs, and derivation requests on label-free fixtures before bulk evaluation. Invalid proposals received contract-only feedback.

The checks do not expose search/test answers or score solution quality. Subsequent continuation follows the upstream candidate loop with the original valid evaluations and incident accounting intact.
