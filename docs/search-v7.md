# Search v7: agent programs, reusable templates, and a dynamic MAS

Historical version. [V8](search-v8.md) added text-first seeds and node-local recovery; see [current search](dynamic-tools-and-topologies.md) for the single-root protocol.

V7 extends native Ditto composition with an inherited, frozen agent library. Internal agent optimization and subagent reuse are part of the same complete candidate as dynamic derivation. Upstream AFlow sampling, experience, full validation, and convergence remain in use.

## Candidate contract

| Field | Searched content | Inference use |
| --- | --- | --- |
| `composition` | Derivation, template choice, assignment, serial/parallel/interleaved graphs, routing, reconfiguration, termination | Frozen dynamic controller responding to current task evidence |
| `organization.initialAgents` | Capabilities, node/tool permissions, goals, reasoning | Fresh profiles per task; authoritative initial configuration |
| `organization.agentTemplates` | Profiles and independent graph/loop programs | Complete executable agents, not just role prompts |
| `organization.initialBindings` | Initial member-to-template mapping | Bind programs without replacing initial profiles |
| `prompts` | agent/factory/review/integrate/retrieve and private role instructions | Frozen with structure |

A template is `{id, description, profile, composition}`. Its profile omits the instance ID. Its native Ditto loop returns AgentOutput; the outer MAS returns an answer string. Registry Ditto 0.1.1 owned execution in this historical version.

```javascript
if (unresolvedGap) {
  ctx.spawnTemplate(selectedTemplate, 'child-1', 'root');
  const evidence = yield* ctx.runAgent('child-1', { deficit: unresolvedGap });
  ctx.dormant('child-1');
  const integrated = yield* ctx.runAgent('root', { evidence }, 'integrate');
  return integrated.candidate_answer;
}
```

## Runtime API

- `ctx.templates`: snapshot of the complete candidate library.
- `ctx.spawnTemplate(templateId,newId,parentId='root')`: instantiate profile and bind program; creation alone does not call a model.
- `yield* ctx.runAgent(id,evidence=[],prompt='agent')`: delegate to the member generator within the same Ditto loop. Agent-local fields are `self`, `evidence`, and `prompt`.
- `ctx.bindTemplate`: change future program/profile; an already-running generator keeps its program.
- `ctx.reconfigure`: change profile only.
- Direct spawn, cross-member graphs, outputs, dormancy, and activation remain available.

Templates may use different nodes and topologies, recursively delegate, interleave generator steps, or share a dependency graph across members. Closures are task-local; each runAgent has separate generator-local state. Code reuse does not carry previous-task messages, answers, members, or execution state. Node/tool permission checks and synchronous loop guards remain.

## Seed, feedback, and freezing

The historical seed library had an editable solver (Context/Sample/tool loop) and verifier (REFLECT). Root solved first, derived a verifier for an unresolved gap, and integrated evidence; it could finish without derivation. The optimizer could rewrite, add, or remove templates and routing. A focused edit could change a template together with its caller, followed by 5 x 119 complete validation executions. Individual templates received no fabricated standalone quality score.

Feedback records real graphs, bindings, profiles, lifecycle, `RUN_TEMPLATE`, template coverage, and correctness on tasks using each template. This association is not a causal contribution estimate.

`best.json`, `organization.json`, and `agent-library.json` retain the same selected artifact, round, and strategy hash. The 486-task test loads it unchanged, with dynamic task-local decisions but no test-driven optimization or aggregation of failed candidates' libraries. V7 required a fresh run; v6 scores were not reused.

## Reliability repair on 2026-09-29

The original v7 run encountered grading subprocess exits, invalid REFLECT output, and requests reaching 393216 output tokens. Large non-whitespace output alone did not prove repetitive content. The old process was stopped and its results retained before changing semantics.

### Separate generation from grading

Save a complete execution atomically before grading. MATH grading concurrency is `min(4, CPU parallelism)`; queue time is excluded from the 30-second subprocess deadline. Retry grading at most three times against the same answer and gold. Persistent failure raises GradingFailure and stops the controller, rather than regenerating the answer or scoring an infrastructure failure as zero. Resume grades saved executions. All 28 distinct inputs recovered from old grader failures completed on the new path without model calls; absent old exit signals prevent attributing every failure to CPU contention.

### Local node recovery

REFLECT INVALID_MODEL_OUTPUT returns through NodeResult to the generator. The verifier requests the required assessment/issues JSON and retries the same target locally once. A second failure publishes verification_error and preserves the unresolved gap and provisional answer. It cannot claim successful verification. Transport/incomplete-response failures still propagate. Ditto retains responsibility for schema parsing and validation.

### Repetition guard and prompts

Prompts ask for a decisive argument, concrete unresolved gaps, valid JSON, and no repeated rewrites or enormous enumeration. They do not truncate input or lower output allowances. Public `text_delta` events detect an exact repeated cycle at least eight times over at least 8192 characters. This is a fault heuristic, not a total-length cap or a semantic correctness test. Cancellation uses AbortSignal; no SSE implementation is copied. Unknown usage is retained, and diagnostics store bounded prefixes/suffixes. Intentional repetition can trigger the heuristic; other long responses may still reach provider limits.

Two previously problematic validation tasks completed in about 12 and 14 seconds with correct grading; one recovered a REFLECT error without rerunning root. These were diagnostic regressions, excluded from candidate scores and not evidence of general accuracy improvement.
