# Search v6: native Ditto Graph/Loop composition

Historical foundation for [v7 template-library search](search-v7.md) and the [current single-root protocol](dynamic-tools-and-topologies.md).

V5's `program(state) -> Decision` controlled external organization actions but left agent internals fixed. V6 switched the search object to complete executable graph/loop composition.

## Candidate representation

- `composition`: JavaScript defining graph builders, independent/nested generator loops, inter-agent bindings, dynamic creation/reconfiguration, and stopping; returns `loop({id, plan: function* (ctx) {...}})`.
- `organization.initialAgents`: profiles with explicit `nodes` and `tools` plus goals and capabilities. V6 allowed heterogeneous initial populations; current search starts from one root.
- `prompts`: editable execution and design instructions.
- Parent context: the complete artifact, measured graph/node/lifecycle evidence, and upstream AFlow experience and scores.

A child inherits the full parent and makes a motivated local change to internal nodes, dependencies, reasoning, loops, communication, or derivation. Task outputs determine the next graph; a graph can contain nodes belonging to several agents.

## Execution boundary

`src/composition.ts` passes native graph plans to registry Ditto's `runtime.loop`, using public `graphStep` and `graph().node(...)`. Ditto owns dependency scheduling, in-graph concurrency, inference, tool execution, and sandbox controls. MFlow owns candidate representation, permissions, task-local membership, search, and evidence.

The application checks node ownership/permissions and records bindings without implementing a second scheduler. The historical 250ms VM deadline limits synchronous candidate code, not model generation. A JavaScript VM is not an OS sandbox for hostile code.

| Capability | Nodes / strategies |
| --- | --- |
| Context | LOAD, SELECT, UPDATE, COMPRESS |
| Sampling | INFER.REASONING.SAMPLE |
| Trajectory | cot, long-cot, tot, got, self-consistency |
| Reflection | REFLECT: critique, verify, revise |
| Integration | DELIBERATE: select, merge, consensus, debate |
| Tools | INTERACTION.ACT.TOOL -> OBSERVE |

For example, a root may use LOAD/SAMPLE, a checker REFLECT, a solver TRAJECTORY(tot), and a calculator a SAMPLE/tool/observe loop. Nodes may be interleaved in one graph or yielded from independent generators.

`ctx.spawn` creates a task-local profile; the candidate still supplies its executable program. A model-designed member first uses a Ditto INFER node to generate its specification. `ctx.reconfigure` changes future permissions; `ctx.dormant` marks inactivity. Execution activates the owning member. IDs use `agentId/localName`.

V6 initially lacked a declarative model-created tool node. It did not invent CREATE_TOOL; later public-package composition support is documented in [Ditto requirements](ditto-requirements.md).

## Evidence and reproducibility

`execution.orchestration` preserves graph nodes, ownership, dependencies, input/output bindings, INITIAL/SPAWN/RECONFIGURE/ACTIVATE/DORMANT/PUBLISH events, profiles, observations, and usage. Optimizer summaries provide representative paths rather than duplicating every long response. Task-local state remains evidence, not state inherited by the next benchmark task.

AFlow parent sampling, experience, five complete repetitions, and convergence remain unchanged. MATH uses 119/486. New execution semantics require new runs; no inheritance of v5 scores. Task-level resume is supported, not serialization of live generators.

Fixtures in `test/composition.test.ts` and `test/aflow-native.test.ts` cover real Ditto graph/tool execution, heterogeneous graphs, concurrency, permissions, label isolation, reset, freezing, repeated validation, and recovery. Scripted providers establish contracts, not model quality.

## Resource policy confirmed on 2026-09-29

No extra round/token/step/member/depth/tool-call experiment quota; `maxRounds:null` and the largest representable numeric limits are used where required. Optimizer input bypasses Context inline truncation. Agent Context used package maxima of 1,000,000 inline bytes/items; truly unbounded Context remained DITTO-006. Synchronous-loop guards, Python time/resource isolation, and node/tool permissions remain. Provider context/output hard limits still apply.
