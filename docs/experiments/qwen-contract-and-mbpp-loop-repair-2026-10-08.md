# Qwen MATH contract repair and DeepSeek MBPP loop diagnosis — 2026-10-08

## Confirmed failures

- Qwen MFlow repeatedly emitted the JSON Schema instead of an instance. Its format-only repair received the invalid output but not the original request or validation error. The frozen runtime did not request JSON output mode. Eighty controller failures had been observed before this repair; these were not completed search rounds.
- The pinned official AFlow CodeFormatter returns `{response: sanitized_code}`, whereas Programmer reads `code`. All 113 completed R2 search rows returned `No code generated`; this is an adapter/interface failure, not measured algorithm performance.
- DeepSeek MBPP R2/pass1/task `mbpp:392` repeatedly executed an unchanged recursive Python function without a terminating base case. Only the scalar input to its final print call increased. The same recursion traceback recurred, bypassing the exact-argument cycle guard. The completed task charged 55,271,480 tokens, including repeated cached input. These costs remain in the ledger; the scored task is not selectively retried.

## Changes

1. Structured Ditto calls explicitly request a JSON instance and `json_object` transport mode. The single format repair receives original instruction/payload and validation error as well as the model output. Native Ditto TRAJECTORY execution, model temperature/seed, and optimizer selection/repetition/convergence are preserved.
2. The application AFlow adapter maps CodeFormatter's `response` to missing `code` only inside Programmer.code_generate. Native code generation, parser, three execution attempts, and isolated Ditto Python execution remain intact. No official source or installed package is edited.
3. A computation guard detects consecutive identical Python failure observations with identical program source after normalizing only a scalar `print(function(...))` probe call. Four repeats receive a repair diagnostic; five produce a node-level DEGENERATE_OUTPUT error and return control to the existing recovery policy. Changed function bodies, successful sweeps, and stateful API calls are not blocked. This is execution-loop protection, not an experiment quota.

## Deployment and recovery

- Local MBPP actor PID 23114 received the recorded application guidance through the existing inspector installer. The in-flight request finished; later repeated computation was rejected before another model request. The task completed with score 0, and the search advanced to pass2. Existing rows and costs remain unchanged. Resume launcher installs the same recorded guard on future processes.
- Local repair receipt: `../experiments/deepseek-mbpp-mflow-feedback-20261008-08cee85/repairs/python-probe-loop.json`.
- Remote repair assets: `/home/b/project/experiments/qwen-math-20261008-contract-repair`.
- Remote MFlow uses three narrowly transplanted structured-format changes in its original frozen application module, loaded through the checksum-verified application repair hook. The rest of that frozen runtime is retained. This avoids importing newer unrelated guide/runtime changes into old checkpoints.
- Remote AFlow is drained at a task boundary. All R2 rows and native mismatch logs are archived outside the eligible search results, with their costs retained. R1's 119 rows and R2's unchanged workflow/parent checkpoint are preserved. The complete R2 validation is repeated under the corrected adapter; no correct/incorrect filtering is used.
- The old scheduler is paused during handoff to prevent duplicate retries. AutoAgents and HLE remain stopped; the legacy DyLAN/EvoAgent handoff is unchanged.

## Verification and limits

- Full Node tests: 171 passed, 4 skipped (175 total), including the final duplicate-guidance handling adjustment; targeted guidance tests cover repeated probe failures, changed implementations, successful checks, and in-flight preservation.
- Python adapter regression verifies response-to-code mapping, preservation of an existing code field, idempotent installation, and dispatch through scoped Ditto Python execution.
- Real Qwen interface preflight: one call, 219 tokens, valid structured instance with executable `solve` code. This is an interface test, not benchmark quality evidence.
- Local MBPP R1 five-repeat mean: 83.2558%; R2's first two repetitions: 68/86 and 69/86. The new spec_probe produced parseable JSON in all 86 first-pass tasks. No search improvement is established yet.
- This repair does not establish that a 9B model can reliably generate every large MAS artifact. Actual subsequent candidates and full validation still need observation. The narrow probe guard does not detect every semantic loop.

## Handoff verification

At 22:16 Beijing the old MFlow optimizer/format-repair call ended naturally. The old search service was stopped, and `hb-qwen-search-contract-repair-20261008.service` started both repaired actors (MFlow PID 1160350, AFlow PID 1160351). Their model requests were observed after startup; a complete new optimizer proposal and R2 validation were not yet available at this check. Qwen's real JSON preflight passed, and the native AFlow CodeFormatter/Programmer path is checked separately with a fixture model and real isolated tool execution.

R2 AFlow's 113 invalidated rows charged 672,578 tokens. The original usage ledger is retained; do not add the archived row totals to that ledger again. The wrapper is loaded from a checksum-recorded repair file while official source files remain untouched.

MBPP resumed R2/pass2 after the repetitive failure ended. Another task (`mbpp:751`) has a long in-flight Python action payload; the existing finite-program guidance and exact-cycle guard have not yet ended that request. It is preserved in accordance with the request not to discard in-flight work. The repetitive-failure repair is not a claim that all long-output problems are solved.
