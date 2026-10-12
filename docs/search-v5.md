# Search v5: heterogeneous organizations and dynamic policies

Historical protocol, superseded by [native graph/loop search](search-v6.md).

V4 retained task execution profiles and graphs but did not carry them through parent expansion and final export. V5 made each candidate a complete `{organization, program, prompts}` artifact. Initial profiles included capability, objective, private context, tools, reasoning, expected output, and stopping criteria. At this historical stage candidates could include dormant reusable initial members; the current protocol starts from one root.

## Inheritance and evidence

- A selected parent contributes its complete artifact, organization statistics from five validation passes, and representative execution graphs.
- `parent_context.json` records the exact parent and evidence. Per-pass `organizations.json` and task execution files retain profiles, outputs, actions, edges, and graphs.
- `organization_N.json` summarizes actual actions, no-ops, undelivered evidence, and derivation coverage, with up to six representative paths. Summarization limits prompt size, not validation coverage.
- `best.json` preserves the selected strategy and pool; `organization.json` makes the frozen configuration inspectable and executable at inference.

## Dynamic actions

`DERIVE` without a profile calls the Ditto factory; an explicit profile is used as supplied apart from identity. `RECONFIGURE` keeps identity, history, and assignments while changing future capabilities. `REACTIVATE` selects dormant members. Nested derivation, evidence routing, consumption, and dormancy are supported.

A child result affects its owner through `CONNECT -> CONTINUE`; rerunning the owner does not deliver unconnected evidence. CONTINUE/REVIEW without `agentId` now correctly defaults to root. Actual task-local graphs inform optimization but are not automatically turned into cross-task answer memory. Standard evaluation resets each task; continual organization is a separate explicit protocol.

## Experimental limits

The v5 seed enabled arithmetic/Python ReAct while v4's root had no tools. A fresh run was required; old scores could not be inherited or the difference attributed solely to additional search rounds. MATH stayed at 119 search / 486 test, DeepSeek Flash, five full validation repetitions, and upstream AFlow sampling/experience/convergence, without MIA, racing, caches, or a fixed round limit.

HTTP service failures and invalid provider JSON interrupt and preserve checkpoints rather than flooding ranking tables with zeros. Provider output exhaustion is distinguished from service unavailability. Unknown reservations are not measured token consumption.

All reasoning and tools used public exports from registry Ditto 0.1.1. Organization configuration and statistical search remain application responsibilities; no spawn-specific runtime was copied from Ditto source.
