# Complete official-baseline rerun (2026-09-27)

Historical unrestricted rerun authorized after the user removed the shared 30M cap. Configuration: baselines/protocol.json; output: runs/baselines-math-unrestricted-20260927. Earlier results/costs remain separate in runs/baselines-math.

## Execution protocol

Registry Ditto 0.1.1, DeepSeek Flash, temperature 0, thinking disabled; identical AFlow MATH 119 validation / 486 test and common grader. AFlow searches before freezing/testing; other methods directly test.

Removed extra 24000 episode, 2280742 search, 30M shared budgets, the 90-second timeout, and 4096 output cap. Public HTTP/inference deadlines were set to the supported 2147483647ms maximum; earlier interrupted usage stays unknown. The configured provider output allowance was 393216, still subject to real API context/output constraints.

AFlow used official Optimizer.optimize('Graph'), the then-default maximum 20 iterations, convergence, one full validation repetition, and Custom/ScEnsemble/Programmer. DyLAN retained four agents, three rounds, consensus; EvoAgent retained three expert iterations; AutoAgents retained its native team/management control. Removing external quotas did not remove algorithmic stopping rules.

Some repeated reasoning reached about 393k output tokens. DyLAN/EvoAgent/AutoAgents mark that terminal task as provider_output_limit with empty answer and full cost, then continue. Resume does not repurchase an already recorded terminal failure. AFlow retains native retries; partial text is not represented as a complete answer.

## Adapter repairs

AFlow casts cumulative cost to float for JSON, checks workflow syntax/prompt references, and deterministically restores valid Python prompt definitions accidentally emitted entirely as comments. Remaining serialization/syntax errors receive contract-only repair preserving modification and algorithm, recorded in AFlow/repairs.jsonl. No test labels or strategy redesign are used. Initial workspace comes from the pinned source; old search graphs are archived.

AutoAgents parses JSON only in Selected/Created Roles List, handles nested braces and example trailing/double braces, reconstructs native sections from repaired structured fields, and requires every planned role to have a complete definition. Omitted still-used roles can be recovered from earlier drafts in the same task. It normalizes spaces/underscores/case and matches full names before splitting, so `Computation and Counting Expert` remains one role. The historical fixed 30-second delay was removed.

Native SearchAndSummarize uses the official CUSTOM_ENGINE interface and the recorded autoagents-custom-search.patch. The chain is native summarizer -> custom engine -> local bridge -> Ditto TOOL -> public createWebSearchTool -> injected DuckDuckGo/ddgs provider. No Brave key was configured. Only service transport/format is adapted; Ditto scheduling/permissions/provider internals are not copied. Overlong search requests are compressed by a metered model; native summarization remains. Search logs are separate, and query compression/summarization costs count.

The initial AutoAgents role-consistency failures were isolated in test-before-role-consistency-fix before a complete restart. Their costs remain part of the historical ledger.

## Reproduction and interpretation

Use pinned sources and recorded patches from baselines/sources.lock.json and the [source/environment instructions](baseline-comparison.md#environment-and-execution). Do not reset a live upstream workspace.

```sh
node baselines/bridge.mjs
# Run each client separately:
../MFlow-baselines/.venv-aflow/bin/python baselines/aflow.py --phase search-test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py DyLAN --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py EvoAgent --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py AutoAgents --phase test
```

Manifests lock code/dependencies/data/grading. requests.jsonl precedes dispatch; usage.jsonl records returned usage and unknown calls. Reconcile requests without terminal records after a crash. Search-service requests themselves are not LLM tokens; their model processing is.

Historical verification: seven adapter checks; 44 engineering tests passed and one Docker integration skipped; all four methods completed validation pilots; real web results returned through Ditto and native AutoAgents summarization. These are functionality checks, not accuracy claims. At that time MFlow retained a 24k episode budget and different tools, so report an unrestricted-baseline comparison with costs/failures, not equal compute.
