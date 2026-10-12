# Single-root MAS and dynamic derivation search

Current protocol uses registry `@codesoul-co/ditto@0.1.2`. Frozen older experiments retain their own execution identities. A new seed, guide, capability set, or runtime cannot silently replace an old manifest. HLE remains stopped unless explicitly resumed; the current experiment policy is search first, freeze, then final test.

## Search protocol corrected on 2026-10-05

There is one search tree. Round 1 evaluates one `dynamic-policy` candidate with one initial `root`. Templates are available programs, not pre-instantiated members. The earlier experiment that spent seven rounds on seven initializations was stopped; those scores are not migrated into the new tree.

- Round 1 evaluates the single seed. Each task starts from root and follows the policy's derivation decisions.
- Later rounds use upstream AFlow sampling over evaluated historical parents. A child can extend an earlier node, creating siblings rather than a mandatory chronological chain.
- A candidate includes complete MAS code, dynamic derivation/stopping/evidence rules, member profiles, internal graph/loops, and reusable agent/tool libraries.
- Diversity is encouraged through branch summaries and mutation directions: trees, parallel merges, context exchange, heterogeneous reasoning, and tool loops. These are search choices, not mandatory roles, seven independent trees, or required tool creation.
- Native prompt adaptation keeps one focused improvement while removing Python-specific five-line and ten-node guidance so a complete Ditto change can be expressed.
- Each candidate receives five independent full-search-set repetitions. Five passes are one round, not five rounds.
- Upstream convergence selects by complete search means. Final test opens after freezing; no automatic per-round tests or test-driven proposals/selection/stopping.

Historical structure generators remain for explicit ablations/reproduction. Default candidate validation requires exactly one initial root. Existing AFlow baseline runs are not redefined by MFlow changes.

## Tool definitions and execution

The old `tool-factory` initialization was removed because tool creation is a member capability, not a MAS topology. `organization.toolCreation=true` exposes `create_tool({definition})` to initial, template, tree-leaf, and generated members. A member can create a tool from its own SAMPLE -> TOOL -> OBSERVE loop and call the new name afterward. No dedicated creator or mandatory design call is required.

Creator identity comes from Ditto `WorkerContext.execution.nodeId`, not model-supplied identity. Enabling creation adds its registry entry and required interaction nodes without homogenizing reasoning graphs or granting every API capability. Read-only planners do not gain write permissions.

- `organization.toolLibrary`: ordered inherited/frozen definitions; dependencies must be available base tools or earlier definitions.
- `ctx.registerTool(agentId,definition)`: register for this task and grant the creator access. Authorized sharing can use spawn/reconfigure.
- `ctx.tools` and `orchestration.tools`: definitions, hashes, origins, and creators.
- Definitions specify a `generated_` name, description, typed parameters, and implementation. Supported parameter types include string, number, integer, boolean, array, and object.
- Python definitions expose `def run(args)` returning JSON through the existing isolated Python tool. They do not gain network, host files, or cross-call state.
- Sequence definitions use `steps:[{tool,arguments}]`, JSON Pointer references `{"$input":"/x"}` and `{"$step":"/0/result"}`, and return the final result. Failure stops without replaying successful writes.

Registration and nested calls use public ToolRegistry.register/call and native INFER/INTERACTION. MFlow owns the search grammar and composition, not a replacement model/container/tool engine. Duplicate names, forward/cyclic/unknown dependencies, and create_tool dependencies are rejected. The creator must hold every dependency; cancellation and call guards propagate through nested calls.

The unsearched SingleLLM seed disables creation and uses only the benchmark's original tools.

## Freezing and task isolation

Search may modify library definitions, internal programs, and derivation using search-only evidence. `best.json` freezes the complete organization. `agent-library.json`, `tool-library.json`, and `organization.json` share selected-round/strategy identities.

Inference reloads definitions and executes the same policy; it may generate new task-local members or tools outside the library. Each task has a fresh registry/world. Generated tools do not automatically enter future tasks or feed back into search. Persisted definitions are source artifacts, not answers, messages, or mutable sessions. General external-resource rollback remains the unresolved part of DITTO-002.

Contract fixtures cover native registration/calls, model-generated definitions, authorized sharing, reload, isolation, invalid dependencies/parameters, write-before-failure protection, nested calls, Docker Python, and interleaved graphs. They are not accuracy evidence.

## Monitoring and scheduling

`scripts/automation_experiment.py` starts only final test after search. `--methods MFlow` can start a new frozen MFlow actor while other methods resume their original snapshots. Scheduler changes are recorded separately in scheduler.json; they do not redefine an actor version. Remote Qwen also uses final-only scheduling.

Status exposes task-level derivation coverage, generated programs, tool creations, successful generated-tool calls, cross-agent graph dependencies, depth, and node failures. Composite internal dependency calls are not counted again as top-level generated-tool use. Runtime success is not proof of improved task correctness. Search curves must distinguish complete five-pass rounds from partial means. Summaries use saved search records without reading test to optimize or duplicating giant requests/world snapshots.

## Shared Ditto design guide

`src/ditto-guide.ts` is the versioned contract for enabled public 0.1.2 APIs: Worker/node/agent distinctions; node I/O; CoT/ToT/GoT/self-consistency; reflection/integration; tool creation; Context operations; serial, parallel, tree, and interleaved composition. Unconfigured package features are not advertised as available.

Search uses this guide. Factory calls through `ctx.textMessages(...,'factory')` or `ctx.messages(...,'factory')` include it, current members/templates, and real tool schemas. Custom design graphs can read `ctx.dittoGuide.text`; ordinary solve calls need not repeat it. Search saves ditto-guide.json; manifests, round candidates, final bundles, and execution identities retain its version/package/hash. Inference rejects missing or changed guidance before paid execution. A guide upgrade requires a separate run.

## Historical deployment and storage repairs

On 2026-10-04 the later v6 experiment was stopped because only its dedicated initialization exposed tool creation. A new version exposed creation to all members and used a separate search directory. Old scores and parents were not reused; baselines retained their own protocols.

Repeated structuredClone of cumulative message histories caused near-quadratic evidence storage. The repair copies mutable containers while sharing immutable strings and streams canonical hashing in chunks with unchanged bytes. It does not remove model context. A 96 MiB Node fixture covers 64 cumulative steps, isolation, and digest equivalence. Frozen runs load recorded application I/O patches with original/replacement hashes, preserving actor source, prompts, Ditto, data, and completed rows.

Native baseline OSError now remains an infrastructure failure. Rows proven invalid because disk writes failed are archived with provenance before retrying a fresh world. Ordinary wrong answers and model-format failures remain; test scores do not authorize selective retries.

## AutomationBench tool creation repair (2026-10-04)

AutomationBench MFlow search now registers the existing isolated Python tool in
addition to the official API tools. Its immutable image ID is saved in the search
manifest and frozen bundle; inference uses that same image. With tool creation
enabled, every initial/spawned/reconfigured agent receives Python when the
deployment provides it. API write capabilities remain heterogeneous. Other
baselines retain their original tool configuration; report this MFlow compute
capability difference in comparisons.

Each create_tool action describes the exact creator, allowed dependency names and
Python availability. Dependency errors name missing and available capabilities.
Discovered API endpoints must be passed to api_fetch, never used as registry names.
This fixes the previous workflow deployment that advertised Python definitions
without providing Python. It does not remove dependency validation.

The updated MFlow experiment starts a new frozen search run because capabilities
and model-visible instructions changed; previous search scores are not reused.

Generated tools are also shared with existing and later-spawned members that
already hold every dependency. Sharing cannot grant API write access to a
read-only planner. This prevents a capable reviewer from seeing a generated
tool in evidence but being unable to use it.

## Dynamic policy search (2026-10-05)

The single policy-first root can design a new graph before acting. All later
candidates start with one agent and evolve the inherited MAS program. Alternative
layouts are branches of the same search tree. AFlow mutates internal programs,
controller prompts and feedback-conditioned derivation jointly.

Each policy decision records stop/continue, rationale and unresolved gap. A
continuation supplies a complete native Ditto graph/loop stage: reuse a member,
spawn a heterogeneous program, reconfigure capabilities, change an existing
program with ctx.bindProgram, or weave multiple members into one dependency graph.
After execution, current profiles, outputs, generated programs and executed
topology are supplied to the next decision. Successful world effects are retained.
Stages return AgentOutput and the complete MAS returns final text. Every model
call and executable node still runs through the published Ditto package.

ctx.structure exposes topology/program/decision evidence without duplicating raw
graph output histories. ctx.recordDecision writes task-local policy evidence; it
is not a grade or correctness signal. ctx.bindProgram changes only future
internal execution, preserving identity and profile. Native INVALID_INPUT feedback
(including malformed REFLECT criteria) returns to the generated program instead
of aborting the entire task before the policy can repair it.

Search feedback covers outcome/topology changes, generated programs, tools,
cross-agent sharing and node failures rather than taking the first six examples.
reusableCandidates contains representative successful program shapes and
successfully invoked tool definitions with provenance. These remain search
evidence, not automatically trusted templates: the optimizer must generalize
away task values, promote useful artifacts explicitly, and re-evaluate the full
candidate. A task passing does not establish a causal benefit for any one tool.

AFlow's parent sampling, experience filtering and convergence test remain in use.
There is one initialization; subsequent rounds are measured mutations. Native
convergence operates on those candidate scores. No maximum search-round or
experiment-token quota is added.

The frozen bundle retains the full initial organization, dynamic control code,
all prompts, reusable library, guide and Python image identity. Search and test
execute the same program; runtime-generated members are fresh for each task and
need not belong to the frozen template library. Test outcomes never enter the
optimizer. The separately user-selected old round 9 test runs in the old v8
snapshot; this changed search starts a fresh independent experiment.

## Generated-program recovery on 2026-10-05

One v10 task spawned a member without binding a program, passed a function where source text was required, and called the `ctx.agents` property as a function. The controller swallowed failures and regenerated 556 times until the provider context limit. This was not successful derivation.

`spawn(profile,parent)` remains valid for members used by explicit graphs, but runAgent requires a template or bound source string. Compilation rejects implicit conversion of functions/generators/objects. Guidance distinguishes property access, source strings, binding, and member reuse.

After three consecutive generated-stage failures, the seed recovers through root's original template with observed outputs/tool effects in the same world. Three malformed controller outputs or context exhaustion use the same path. This bounds fault recovery, not successful stages, agent counts, or search rounds. `ctx.structure.programs` supplies current bindings to design; the audit retains full history.

Transient fetch/socket/502 failures retry the current model call at most twice without replaying successful tools. Unknown usage remains recorded. Authentication and insufficient balance stop instead of retrying. The changed seed/guide started a fresh v11 search; v10 repetition scores were not mixed. Baselines continued their own frozen checkpoints.

## Capability versus observed behavior

Supported derivation mechanisms do not imply that every selected policy uses them. In the BFCL R29 supplementary test, all 600 tasks spawned `turn_runner` instances from the same template (1,356 creations total); no root-only task or successfully registered generated tool was observed. See [R29 ablations](experiments/bfcl-round29-ablations-2026-10-11.md). Report the measured topology separately from the framework's broader search space.
