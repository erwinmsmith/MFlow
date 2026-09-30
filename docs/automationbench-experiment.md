# AutomationBench / DeepSeek Flash comparison

## Protocol

All five methods use the locked `automationbench-public-simple-v1` views: 200 simple tasks for development/search, followed by all 600 public domain tasks for held-out evaluation. This is a documented cross-domain development protocol, not an official training split or private leaderboard submission. Task IDs, data hashes, source hashes and dependencies are checked before execution. Test tasks and private rubric/state never enter search, mutation or actor prompts.

Every episode starts a fresh official world. All actors within that episode share it. Only the published Ditto package executes model requests and registered external tools (`api_search`, `api_fetch`, `base64_encode`). Official AutomationBench 1.0.6 scores actual world changes; final prose is not execution evidence. Report both strict pass rate and mean partial credit.

Model: `deepseek-flash`, temperature 0, thinking disabled. Output allowance is 393216 tokens; no experiment token ceiling, search-round ceiling, agent-count or derivation-depth quota. Generated-code and external execution guards remain. The existing Qwen service is retained.

## Search and execution

- **MFlow:** five measured roots: single executor, executor/reviewer, plan/execute, parallel complementary planners/execute, and a task-local adaptive factory. Every root receives five complete 200-task validation passes before becoming eligible as a parent. Descendants use the original AFlow optimizer's parent sampling, experience, validation and convergence control. Mutations inherit complete MAS configuration, bindings, graphs and prompts.
- **AFlow:** original static Workflow, Custom and ScEnsemble operators; three measured roots: single, plan/execute and review. The same native optimizer and five full validation passes apply. Python operator model calls are transported through Ditto; generated workflows cannot import host capabilities or access private state. Programmer is not an AutomationBench operator.
- **DyLAN:** original population, rounds, ranking, pruning and consensus; workflow evidence replaces math-only answer normalization/examples.
- **EvoAgent:** original role evolution, retention, collaboration and refinement; workflow instructions replace boxed math output.
- **AutoAgents:** original role design, observer, execution plan and group loop. Its custom search interface invokes the benchmark's official API discovery tool through Ditto.

DyLAN, EvoAgent and AutoAgents run all 200 development episodes, then all 600 test episodes. Their role creation within an episode is native inference work, rather than cross-task statistical search. Planning prompts require reasoning without writes; MFlow planning profiles and baseline ranking/role-design calls disable tools. Actors receive identical API tools. Original baseline sources are pinned and verified, not edited in place.

MFlow uses five roots and AFlow three: search compute is therefore not equal. Search, optimizer, retries, development and test usage are retained separately; compare accuracy together with measured cost. No test results select a round or prompt. The selected bundle/workflow is frozen before test.

Inference freezes the **policy**, not the realized MAS. `ctx.spawn(profile, parentId, composition)` can compile a new task-local subagent program outside the template library, then `yield* ctx.runAgent(id, assignment)` executes it with public Ditto nodes. Profiles can differ in tool access, reasoning and graph/loop design. Generated sources, actual graphs, bindings and lifecycle events are retained in each execution. These programs never alter the frozen bundle or survive into another test task.

## Remote execution and progress

Each experiment runs from a separate immutable snapshot under `hb:/home/b/project/experiments/`. Source, build, configuration and dependency hashes are saved in `experiment-manifest.json`. Qwen MATH and DeepSeek AutomationBench use separate snapshots, outputs, profiles and bridge ports (8198 and 8197 respectively). Shared datasets and Python environments are outside code sync. Local code remains authoritative for `/home/b/project/MFlow` and must pass `bash scripts/sync_hb.sh` checksum verification.

From the DeepSeek snapshot directory:

```bash
bash scripts/hb-model.sh deepseek python3 scripts/automation_experiment.py
python3 scripts/automation_experiment.py --status
bash scripts/hb-model.sh deepseek python3 scripts/automation_experiment.py --resume
```

The 2026-09-30 snapshot is `/home/b/project/experiments/deepseek-automation-20260930/MFlow`. Query it directly from a local terminal:

```bash
ssh hb 'cd /home/b/project/experiments/deepseek-automation-20260930/MFlow; python3 scripts/automation_experiment.py --status'
ssh hb 'systemctl --user status mflow-deepseek-automation-20260930 --no-pager'
```

The runner starts all five methods, then automatically advances each from search/development to the full test set. Initial concurrency is 24 MFlow episodes, 12 AFlow episodes and two worker processes for each of the other methods. Official worlds are multiplexed in one Python bridge per Node process to avoid repeating imports for every episode. LLM requests remain concurrent; benchmark API requests are short, serialized local operations.

Outputs live in `runs/automationbench-deepseek-flash-20260930/`: `jobs.json`, one log per method, `bridge.log`, `usage.jsonl`, request progress, per-task world checkpoints and results. `--status` reports phases, current round/pass, completed counts, correct counts, token accounting and transport activity. Completed rows are preserved. If only scoring fails, the saved world is regraded without new model calls. Provider/infrastructure failures stop the affected stage and remain visible; they are not recorded as ordinary wrong answers.

Resume requires the same immutable snapshot and configuration. It reuses completed tasks, partial validation passes and frozen selection; it does not reinterpret partial roots as converged search. A code repair requires an explicitly recorded new snapshot/run. Scripted providers in local checks only verify contracts and isolation; they are not benchmark performance evidence.
