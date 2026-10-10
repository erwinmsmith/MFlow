# BFCL disk recovery and evidence storage

BFCL uses the pinned shared benchmark installation. Each conversation opens its
own official world and exposes only the currently revealed function schemas via
the Ditto-registered `bfcl_state`, `bfcl_call`, and `bfcl_respond` tools. The
adapter closes the process when the episode ends. It does not copy the full tool
implementation into each run, download images per question, or expose withheld
functions early. Keep the shared official tool source and environments installed.

The main recurring disk cost is saved tool/schema evidence, not tool installation.
Set `MFLOW_COMPRESS_EVIDENCE=1` on macOS to transparently compress large JSON
checkpoints before atomic commit. Python search feedback uses the same opt-in
policy. Every compressed write is verified against the uncompressed bytes; the
paths, JSON contents, model inputs, scores and usage accounting remain readable
without a special loader. Linux writes ordinary compact JSON. Append-only usage
ledgers are retained. Compression failures do not replace the previous checkpoint.

Search RPC transport failures exit without passing through AFlow's candidate-skip
handler. They must not advance the round, consume a parent-selection attempt, or
count as zero accuracy. Each supervisor actor and bridge runs in a separate process
group so shutdown also terminates controller/tool descendants. Interrupted jobs
are recorded as interrupted instead of being left marked running.

For the October 10 BFCL interruption, the valid continuation is MFlow round 20,
with its first three 200-task passes committed, and AFlow round 19, with its first
two passes committed. The orphan controller's later round numbers are not measured
candidates. A recovery receipt must preserve the damaged checkpoint, identify the
exact proposal matching round 20's artifact and its parent, and record the installed
repair modules. Reuse committed task results and all usage ledgers. Do not infer a
new score or convergence from the interrupted round. The pre-interruption random
state cannot be reconstructed from a checkpoint overwritten by the orphan; retain
and disclose the surviving state rather than claim bit-for-bit continuation.

Tests: `npm test`, including disconnected RPC classification, process-group cleanup,
atomic transparent compression, and concurrent checkpoint ordering. Scripted model
fixtures verify contracts only, not benchmark quality.
