# Original organization-strategy research proposal

This is an edited English record of the original DSL/MIA proposal. It is a historical research design, not a specification of the current default algorithm. Native AFlow optimization and Ditto graph/loop search later replaced MIA, partial evaluation, and caching in the default path. See [legacy implementation details](architecture.md) and [current design](dynamic-tools-and-topologies.md).

## 1. Four distinct objects

| Object | Meaning | Lifetime |
| --- | --- | --- |
| `A^P` | Persistent agent population | Across tasks only in the explicit continual protocol |
| `G(x,t)` | Active task-specific agent/evidence graph | One evolving task |
| `pi` | Reusable organization policy | Search candidate, then frozen inference program |
| `T_search` | Policy search tree | Search only |

Search produces `pi*`. Inference produces `G(x) = Rollout(pi*, x, A^P)`. A large available population can still yield a one-agent execution. The search tree is distinct from the runtime interaction graph.

## 2. Agent and graph state

An agent has an ID, open-ended capability description, responsibility, granted tools, private memory, long-term context, provenance, and an ACTIVE/DORMANT/RETIRED state. Episode context is task-local. In continual operation, consolidation extracts procedural memory before dormancy; raw task context is not automatically permanent.

An edge records source, target, artifact/deficit, and relation type. It explains what evidence is being delivered and why. The initial design uses no continuous edge-quality weight.

Structured output contains candidate answer, claims, evidence/artifacts, open deficits with owners, resolved deficits, and tool events. Deficits describe unresolved task-relevant information in open language; they are not a fixed catalog of verifier/programmer/researcher roles.

```yaml
candidate_answer: "..."
claims:
  - id: c1
    text: "..."
    evidence_refs: [e3]
artifacts:
  - id: e3
    type: symbolic_result
    content: "..."
open_deficits:
  - id: d2
    text: "The equality condition remains unsupported."
    owner: A0
resolved_deficits: [d1]
tool_events:
  - tool: python
    status: success
```

## 3. Information-realization states

| State | Meaning | Candidate organizational response |
| --- | --- | --- |
| MISSING | No reusable relevant source exists | Derive a member or continue locally |
| LATENT | A relevant source is dormant | Reactivate/retrieve |
| ACTIVE / UNROUTED | Relevant work/evidence exists but has not reached its owner | Continue or connect |
| DELIVERED | Owner received evidence but has not resolved the deficit | Integrate/continue |
| RESOLVED / OVERACTIVE | Need is resolved or activity is redundant | Dormant/disconnect/stop |

Relevance can be classified by an LLM from capability descriptions and the deficit. It does not require an LLM reliability, information-gain, or expected-utility number. A child claiming success does not by itself close the owner's deficit.

## 4. Policy representation and root

`pi(state)` chooses CONTINUE, DERIVE, REACTIVATE, CONNECT, DISCONNECT, DORMANT, or STOP. Runtime resolves the relevant owner/source. The policy decides organizational control; a factory supplies open-ended objectives, context, and granted tools when a new member is required.

The initial policy runs Root and stops when complete. Every runtime task begins with Root. A search node stores a complete policy; an edge stores a local edit. Suggested edits add/remove guards, change actions/priorities, add/remove fallbacks, change recursion/stop logic, or change reuse order.

```text
Parent:
  WHEN deficit == MISSING: DERIVE

Child:
  WHEN deficit == MISSING AND local_progress_stalled: DERIVE
  ELSE: CONTINUE
```

The root is fully evaluated on the search reservoir. Parent selection balances measured utility and exploration. For a selected parent, observed deficit states restrict legal mutation directions: MIA's first proposed role is search-space guidance. Semantic agent specializations remain open-ended.

## 5. Execution-derived posterior

For edit `e`, compare child and parent on the same task. Outcomes are correction (`0 -> 1`), neutral, or harm (`1 -> 0`). Maintain `theta_e = (p_plus, p_neutral, p_minus)` with a Dirichlet(1,1,1) prior. Seven corrections, four neutral outcomes, and one harm produce Dirichlet(8,5,2).

Only real executions update observations. LLM confidence, pairwise judgments, and invented edge scores do not substitute for downstream correctness. Pooling edits across contexts requires an explicit exchangeability assumption.

Let `q_e` be trigger coverage from parent traces. A posterior sample estimates population-level gain as `mu_e = q_e * (p_plus - p_minus)`. Sample possible worlds and identify the best edit `E*` in each. Their empirical distribution gives uncertainty `H(E*)`.

The second proposed MIA role is active experiment selection:

```text
Acquisition(e) = H(E*) - E_outcome[H(E* | outcome of e)]
              = I(outcome of e; E* | execution history)
```

Select the legal edit with highest expected decision information. Bootstrap first with a few real observations per mutation family, round-robin or trigger-coverage priority, because identical priors initially provide little ranking information.

## 6. Affected tasks and progressive validation

The proposal identifies tasks whose recorded parent decisions would change under the child. Unchanged recorded trajectories can be inherited; only affected tasks are newly executed. This is a fixed-sample reuse protocol, not proof of equal stochastic rollout distributions.

Evaluate a small affected batch, reject clearly harmful candidates under a declared racing rule, and expand promising ones to the full affected set. Full reconstructed validation and any configured confirmation are required before promotion. Confirmation is used for selection and is not an unbiased final test.

Optional prefix caching restores explicit state before the first divergence. Optional agent-turn caching keys on complete local state, incoming artifacts, tool state, model, and execution configuration. Snapshot the population as well as policy; otherwise comparisons change two variables. External side effects require explicit isolation/transaction handling.

## 7. Promotion, cost, and stopping

Utility is measured downstream performance. Cost, active population, and depth can be declared feasibility constraints rather than arbitrary additions to correctness. Record both actual new cost and logical replay cost without double counting.

Candidates must complete the required evaluation and improve the declared comparator before promotion. Budget-interrupted candidates retain observations but cannot be promoted as fully evaluated. Possible stopping rules include configured resources, exhausted legal edits, or stable utility with low decision information after bootstrap. Local saturation does not establish a global optimum.

```text
Evaluate the root on the full search set.
Repeat:
  Select an evaluated parent using utility and exploration.
  Read its measured deficit traces.
  Generate legal edits, optionally filtered by MIA state.
  Select an edit through bootstrap or information acquisition.
  Snapshot the parent policy and population.
  Execute affected tasks progressively; retain real paired outcomes.
  Update the posterior and full candidate record.
  Promote only after complete validation/confirmation and feasibility checks.
Freeze the selected policy and initial population.
Save the search tree, provenance, execution history, and cost ledger.
```

## 8. Frozen inference

The search tree is no longer consulted. Root attempts the task; when no open need remains, the policy may stop with one agent. Otherwise, retrieve a relevant dormant member or derive a new one with an objective, private method/context, permitted tools, required evidence, and stopping condition.

The member reasons and uses tools independently. Route its artifact to the owner, update task state, and apply the same frozen policy again. New deficits can cause further derivation, reuse, evidence routing, or dormancy. Different inputs can yield Root only, a single helper, a hierarchy, or a multi-member integration graph. No fixed member count or one mandatory verifier is inherent in this proposal.

## 9. Standard and continual protocols

**Standard generalization:** freeze the policy and initial population; reset every test episode. Newly derived members and memory must not leak into later test tasks.

**Continual organization:** explicitly allow population/memory evolution along a declared task sequence. Preserve provenance and separately account for consolidation. Study whether derivation decreases, reactivation increases, and cost per task falls while quality holds. Do not merge these results with standard evaluation.

## 10. Proposed ablations and implementation order

| Variant | MIA space guidance | MIA acquisition | Evaluation |
| --- | --- | --- | --- |
| Random tree search | No | No | Real execution |
| LLM-guided search | No | No | Real execution |
| MIA-Space | Yes | No | Real execution |
| MIA-Acq | No | Yes | Real execution |
| MIA-Full | Yes | Yes | Real execution |

Plot best validation utility against both search executions and search tokens. Equal/better policies at lower measured search cost would support a search-efficiency claim; final accuracy alone would not.

The proposed implementation order was: policy DSL/search tree/real evaluator; structured deficit lifecycle; MIA space filtering; execution-derived posterior and Monte Carlo information acquisition; then persistent reuse and continual experiments. Each stage requires separate evidence. These are research proposals and historical design choices, not claims of measured superiority.
