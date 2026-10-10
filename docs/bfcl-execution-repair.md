# BFCL execution repair (2026-10-10)

The R18 `turn_runner` appended an assistant tool-call batch before its local
schema gate. Rejected calls then remained in history without observations. A
later inference received HTTP 400. Its clarification instruction also incorrectly
nested the framework `bfcl_respond` interface inside the task-function wrapper
`bfcl_call`.

Runtime changes:

- Validate generated inference message bindings before model admission. Missing,
  duplicate or orphan tool replies become stage contract feedback. Do not invent
  observations, delete executed calls or replay successful effects.
- For tool-enabled agent inference that returns `INVALID_MODEL_OUTPUT`, allow at
  most two format retries with corrective instructions. Each attempt is separately
  metered. Tools from the malformed response have not been dispatched; only the
  model response is retried. Factory-only inference, HTTP 402, protocol failures
  and grading are outside this recovery path.
- Explain framework tools versus revealed task functions in the BFCL instructions
  and require schema validation before recording an assistant batch in the node
  design guide. All execution continues through published Ditto public APIs.

Active-run repair must be recorded separately from its frozen runtime. Drain the
current validation pass, retain earlier rounds, and archive invalidated R18 rows
and their old manifests. Keep usage ledgers in place so costs include original
attempts. Correct the R18 gate ordering and clarification instruction, then repeat
all five validations of that corrected candidate before it can be selected. Do
not mix old and repaired candidate scores or use test feedback in the repair.

Tests cover local rejection before paid admission, multi-call observation pairing,
bounded format recovery, usage retention, and no replay of completed effects. A
scripted replay of the actual repaired R18 verifies that a rejected proposed task
call leads to exactly one direct `bfcl_respond`; it is contract evidence, not a
claim of model quality. Remaining malformed generations can still exhaust retries
and must remain visible as failures.
