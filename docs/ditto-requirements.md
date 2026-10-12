# General-purpose Ditto requirements and acceptance checks

Current dependency: registry `@codesoul-co/ditto@0.1.2`. This log retains the original 0.1.0 audit, the 0.1.1 release, later corrections, and remaining gaps. MFlow does not import a Ditto checkout, private modules, vendored execution code, or patched node_modules.

Datasets, fixed splits, benchmark-specific prompts, scoring adapters, search, and organization policies belong to MFlow. Ordinary external tools use RegisteredTool/Interaction; external-resource transactions are only required when promising rollback/branch isolation, not for every standard task-local tool call. BFCL now has an interactive adapter; GAIA and tau3 remain asset-only.

## Published and integrated

| Requirement | Public contract | Acceptance evidence |
| --- | --- | --- |
| DITTO-001 | checkpointState/restoreState, Graph checkpoint, explicit Loop stateCheckpoint | JSON round-trip, suffix equivalence, rejection of changed versions/resources/prior decisions |
| DITTO-002, explicit state only | BranchStore/StateBranch snapshot, fork, discard, atomic commit, conflict detection | Cache isolation and atomic profile/memory/provenance commit |
| DITTO-003, reservation ledger | TokenBudget/budgetedProvider admission, settlement, unknown usage, scopes | Concurrent admission, search/episode scopes, nonzero unknown accounting, logical/actual cost separation |

Historical 0.1.1 release: Ditto main `041562d`, tag `v0.1.1`, registry tarball integrity `sha512-gqZR8bXw5Rdy66frNUNR/y870nHixcm9SccycBJD/8GKysvOrxLO2TxxqveyghwqyDzCIkjxRIiZ8zJ+gjaEBw==`. The current 0.1.2 release followed dev `c8ac380` and main `b6eb649`. Changes follow dev -> main -> registry publication -> consumer lockfile/API checks.

These are general runtime capabilities; spawn, MIA, and benchmarks are not package concepts.

## DITTO-001: explicit state recovery supported

Graph checkpoints wait for in-flight nodes to finish and skip completed nodes on restore. Uncertain external operations cannot be replayed automatically. Explicit loops save state and the next index. Live generators, closures, and arbitrary resources are not serializable.

MFlow can checkpoint serializable organization state at completed-call boundaries. Copying state or rebuilding a runtime is not arbitrary Worker suspension/resumption.

## DITTO-002: external-resource transactions remain unsupported

**Gap:** discoverable snapshot/fork capabilities, opaque versioned handles, ownership/scopes, disposal, and remote commit/conflict contracts. A BranchStore JSON namespace does not isolate Redis, SQL, files, or a tool process.

**Reproduction:** register a file/database-writing tool, run it in a StateBranch, and discard. The external write remains; serializing its return value cannot roll it back.

**Requested contract:** ResourceAdapter capabilities for snapshot/fork/commit/discard; typed/versioned owned SnapshotRef; one scope binding Context/Memory/artifact/tool sessions; isolated write sets and conflict detection; explicit refusal of non-atomic combinations; deterministic disposal. Irreversible operations must declare unsupported rollback.

**Acceptance:** parent K=v1; branch A writes v2 and creates a temporary file; B still sees v1 and no A file. Discard A cleans its resources. Commit B is atomically visible. Conflicts, partial resource failure, and nonrollbackable tools fail closed.

Legacy prefix/cache/continual commit only promise explicit-state and pure-arithmetic isolation. Standard task-local external tools do not require this transactional promise. Do not implement replacement remote transactions inside MFlow.

## DITTO-003: provider bounds remain distinct from budget reservations

TokenBudget strictly controls admitted reservations, not an unknown provider's true protocol/input/hidden-reasoning consumption. Missing usage remains unknown with a conservative charge.

MFlow's historical estimator uses serialized UTF-8 request bytes + output allowance + 1024; callers can inject a validated estimator. Exceeding reservation stops a budgeted run. This is not a proven physical token ceiling.

**Requested contract:** provider usageGuarantee, complete-request tokenizer/upper-bound estimation, output/reasoning semantics, and known failure/cancellation usage; strict admission may reject providers without guarantees.

**Acceptance:** tools, non-ASCII input, and hidden reasoning are included; strict mode rejects unverifiable bounds; retries/failures retain consumption; multiprocess use shares an authorized ledger.

## DITTO-004: stream progress partly resolved; error usage still needed

The 2026-09-27 audit incorrectly stated that 0.1.1 had no public streaming API. Reinspection on 2026-09-28 found ModelProvider.stream with text_delta and final result. MFlow consumes it directly; Ditto owns SSE parsing, tool-argument assembly, cancellation, and network handling.

0.1.2 added public reasoning_delta/action_delta across three HTTP protocols and optional idleTimeoutMs based on actual generation; empty SSE heartbeats do not count. MFlow records text/argument/reasoning character counts without storing reasoning content in progress logs. SDK acceptance reported 459 checks.

**Remaining gap:** provider request IDs, field paths for parsing errors, and known usage attached to cancellation/parse failures. Lack of text_delta alone must not be treated as a stalled tool request.

**Reproductions:** tool arguments equal to the JSON string `null` raise INVALID_MODEL_OUTPUT although a provider frame may contain usage; the error loses that usage. On 2026-09-30, AutomationBench `simple.gmail_invoice_email` generated for about 15 minutes, exposed only 404 text characters, then failed with unclosed argument JSON at position 786428 and lost usage.

**Acceptance:** chunked text, reasoning, tool arguments, keep-alive-only periods, idle/overall deadlines, cancellation, malformed/truncated JSON, and final usage all have distinct observable states. Preserve known usage and exact field paths through parse/callback failure. Never silently retry an uncertain paid request or account it as free. MFlow must not copy a provider/parser to fill this gap.

## DITTO-005: current restricted tool grammar supported by public composition

The 2026-09-29 request sought serializable, versioned code artifacts with names, schemas, language, permissions, isolation, registration/revocation, collision handling, cancellation, persistence/reload, task-local scope, and no host eval. A general artifact-to-RegisteredTool constructor was not exposed as one declarative node.

On 2026-10-03, registry 0.1.2 was rechecked: the required restricted grammar can use ToolRegistry.register/call, createInteractionWorker with that registry, and the existing Python Sandbox. MFlow validates parameterized definitions; Python delegates to the existing python tool; Sequence binds JSON arguments and calls dependencies through the same registry. Each task has a fresh registry. Definitions, not mutable runtime state, are frozen and reloaded.

Model generation, registration, authorized cross-member use, reload, and task isolation are integrated. The earlier conclusion that *any* tool creation required a new release was too broad. See [current implementation](dynamic-tools-and-topologies.md).

**Remaining general proposal:** arbitrary languages/environments, general revocation, lifecycle/storage interfaces, version/permission/environment identity, atomic failure cleanup, and resource ownership. Acceptance should cover A generating/registering/saving a tool, B invoking it, restart/reload, and a new task using the immutable definition without leaking prior messages/state. MFlow does not implement that general infrastructure; its restricted grammar does not need it. External transactions remain DITTO-002.

## DITTO-006: disabling Context storage limits remains unsupported

Reproduced on registry 0.1.2 on 2026-10-06: a 1,000,001-byte CONTEXT.LOAD item fails. Number.MAX_SAFE_INTEGER is out of range and zero fails positive validation. The v11 runtime now returns native Context errors to the suspended stage in the same world, preserving successful writes; this does not remove package limits or truncate content.

The 0.1.1 policy defaults were 65,536 inline bytes and 256 items, with accepted integers 1..1,000,000. Infinity/null/larger integers do not mean unbounded.

**Requested contract:** explicit unbounded maxInlineBytes/maxItems or transparent artifact/reference storage preserving complete downstream inference content, ordering, metadata, ownership, serialization, cancellation, and errors.

**Acceptance:** defaults remain compatible; opt-in >1 MiB messages and larger item counts are preserved without truncation/reordering. Model context overflow remains explicit. Applications do not split prompts or copy Context internals. Optimizer calls can already use public INFER directly when inline Context storage is unnecessary.

## DITTO-007: coordinating context capacity and output allowance

On 2026-10-01, public createHttpProvider with DeepSeek Flash rejected 700010 input tokens plus max_tokens=393216: 1093226 exceeded 1048576. A short actual answer could still fit, but the requested allowance prevented admission. Another AutomationBench request failed after 654109 input tokens; missing original error details prevent asserting an identical cause.

**Requested contract:** public context/output capacities, complete request token counts including tools/images, opt-in allowance adjustment to true remaining capacity, and recorded original/effective allowance plus provider code/message/request ID. Do not truncate input, treat estimates as exact, or silently change model/reasoning mode.

**Acceptance:** intact input; short output admitted when only requested allowance overflows; explicit error if input itself exceeds capacity; traceable retries/usage; safe behavior for tools, multimodal content, cancellation, and unknown-capacity providers.

MFlow records provider errors through public fetch injection and returns explicit capacity failures for policy recovery. It does not implement a tokenizer, SSE stack, or adaptive replacement provider. Other HTTP/authentication/service failures still interrupt the affected experiment.
