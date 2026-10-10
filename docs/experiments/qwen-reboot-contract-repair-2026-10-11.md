# Qwen MATH recovery after reboot — 2026-10-11

## Cause

The enabled `hb-qwen-search-repair-20261007.service` restarted the original
frozen launcher after the October 9 reboot. The October 8 contract-repair
service was static, so its recorded model-format and AFlow Programmer repairs
were not loaded. A running supervisor therefore did not imply a repaired actor.

MFlow's pending R2 artifact also pre-created `reviewer` and `independent`, then
called `spawnTemplate` with the same IDs. It repeatedly failed after sampling
root. R2 had no scored examples. The current repository already enforces a
single root, but this older frozen search adapter lacked that check.

## Repair scope

- Retain the frozen Qwen model, splits, optimizer, prompts, candidate programs,
  validation repetitions, and convergence settings.
- Correct MFlow R2's initial population/bindings to root only; keep its agent
  templates and dynamic composition unchanged. Archive the original artifact
  and manifest. Preserve all attempt and token records.
- Transplant the current single-root validation and corresponding interface
  instruction into the frozen application search adapter through the existing
  checksum-verified module hook. Invalid future proposals go through its
  existing contract-repair path before task inference.
- Load the previously verified October 8 structured-output and native AFlow
  `response`-to-`code` repairs from the persistent launcher. No installed Ditto
  package or official baseline source is modified.
- Enable the replacement systemd service at `default.target` and disable the
  obsolete October 7 service so reboot cannot silently select the old launcher.

## Results and accounting

The reboot cutoff is `2026-10-09T04:22:57Z`. AFlow request timestamps identify
the affected execution cohort independently of correctness:

- Preserve all 119 R1 rows (101 correct).
- Preserve all 63 R2 rows completed under the repaired adapter before reboot,
  including its seven failures (56 correct). This is an incomplete subset, not
  an R2 search accuracy.
- Archive and re-evaluate the 56 R2 rows executed after reboot. They all returned
  `No code generated`.
- Archive the incomplete old R3 and invalidate its selection, which used the
  compromised R2 feedback. Resume evaluating the unchanged R2 candidate, then
  let native AFlow select subsequent candidates using valid results.
- Retain existing RNG state, R2 workflow hashes and parent identity. Remove the
  invalid native score/experience/mismatch feedback. Keep all usage ledgers;
  archived costs must not be added to them a second time.

MFlow R1 remains a five-repeat search mean of 94.6218%; no R2 improvement or
final test accuracy is established by this repair.

## Verification and deployment evidence

Repair receipts, original artifacts, archive and launcher are stored on `hb`:
`/home/b/project/experiments/qwen-math-20261011-repair`.

The original MFlow artifact reproduced the duplicate-ID failure with a fixture
provider. The corrected artifact passed agreement, disagreement with arithmetic
tool execution, and final integration paths through the frozen application and
published Ditto runtime. These are interface checks, not quality measurements.
The native AFlow CodeFormatter/Programmer path with a fixture model and real
isolated Ditto Python execution returned `5` successfully.

Local `npm test`: 171 passed, 17 skipped, zero failures (188 total). Docker was
kept closed locally; Docker-dependent checks were skipped. Remote isolated
Python was checked separately. DyLAN, EvoAgent and the Qwen model service are
outside the repaired search service and remain running.

The handoff lets existing model requests finish and holds subsequent AFlow
requests before transmission. The obsolete supervisor is paused during the
handoff to prevent duplicate restarts. After handoff, verify the replacement
service is **enabled and active**, both actor commands use the recorded repairs,
and real request logs advance; process presence alone is insufficient.

## Completed handoff

At 02:38 Beijing on October 11, the replacement service was enabled and active;
the October 7 service was disabled and stopped. MFlow PID 589404 resumed R2/pass0,
and AFlow PID 589405 resumed the remaining R2 cohort through the recorded repair
wrapper. Both produced fresh streaming text. All existing upstream requests had
finished before stopping the old service. The next AFlow request was held before
transmission. DyLAN PID 3986, EvoAgent PID 4046 and model PID 2288 were preserved.

The invalidated archive contains 56 R2 and 55 incomplete-R3 AFlow rows. Subsequent
scores require real evaluation; fixture success and fresh streaming do not
establish model accuracy. `scripts/sync_hb.sh` completed successfully with source
content checksum verification.
