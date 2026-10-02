# Local DeepSeek comparisons — 2026-10-02

AutomationBench and HLE run locally after hb stopped accepting SSH connections. Both use DeepSeek Flash and published Ditto 0.1.1. The five methods run concurrently in each comparison; every method completes search/development before its final full held-out test. MFlow and AFlow additionally test each fully validated round in an independent observer process. Native search/selection/convergence, data partitions and execution protection are retained.

| Benchmark | MFlow episodes | AFlow episodes | Workers per DyLAN / EvoAgent / AutoAgents | Ditto bridge | Full split |
| --- | ---: | ---: | ---: | ---: | --- |
| AutomationBench | 16 | 16 | 2 | 8297 | 200 development / 600 test |
| HLE | 4 | 4 | 1 | 8299 | 200 search / 2300 test |

These are concurrent task counts, not token, round or context budgets. Native graphs can make additional concurrent model calls. All calls still use Ditto's published model and tool interfaces. HLE is the existing custom multimodal holdout with the Flash judge and filtered web retrieval, not an official full-test/no-tools score. Local web retrieval no longer depends on an SSH relay.

## Snapshots and provenance

The complete local runs live below `/Users/erwin/Downloads/codespace/experiments/deepseek-local-20261002-v3/`, with separate `automationbench/MFlow` and `hle/MFlow` snapshots. Each has its own registry-installed Node dependencies, private `.env`, output and bridge. Data stays in the shared `codespace/Benchmarks`; Python environments are reused, and copied upstream baseline source files are hash-verified. No Ditto checkout or linked runtime is used.

Server checkpoints could not be downloaded. Local quality results therefore start afresh, and must not be merged with server evaluations. Old server data/results remain intact. A local one-shot launchd job, `io.mflow.hb-deepseek-retire.20261002`, retries SSH until it can stop only the old DeepSeek AutomationBench/HLE services; it does not stop Qwen. Its receipt is `/Users/erwin/Library/Logs/MFlow/hb-deepseek-retire-20261002.log`. Until that receipt confirms shutdown, the old server's execution state remains unknown.

Local v1 is an archived startup attempt. It exposed transient connection failures that native AutoAgents retry handlers could wrap and score as task errors. Preserve its rows, unknown-usage requests and costs as startup overhead; do not combine its quality rows with v2. No test task was used to make these repairs. Local v2 is also archived: task-specific prompts and stage tool permissions changed before any held-out testing. Keep its development rows/costs separately; v3 starts fresh rather than mixing configurations.

## Runtime repairs and supervision

- Baseline inference reuses MFlow's existing transient retry policy. Every attempt is still written to the shared cost ledger. HLE judging keeps its existing metered retry layer without nested retries.
- Shared bridge calls classify infrastructure failures consistently. A transport failure escapes native formatting/retry handlers and prevents a scored task row. Model-output failures remain quality evidence.
- In parallel mode an interrupted method resumes after 60 seconds. The bridge first releases that method's unfinished sessions through public Ditto runtime shutdown; saved checkpoints and other methods are preserved. MFlow retries add `--resume` once a manifest exists.
- The runner freezes effective search/baseline settings, ports and worker counts in the experiment manifest. Changing these refuses resume. macOS memory admission uses free/reclaimable pages instead of `/proc/meminfo`.

macOS denied launchd access to Downloads. Experiment supervisors instead run as detached processes started from the authorized local session, with `caffeinate` preventing idle sleep. They survive this chat ending; keep the Mac powered and connected. Each benchmark's sibling `start.sh` restarts a failed runner after 60 seconds, exits after completion, and `supervisor.json` records its process group. A reboot requires relaunching from the authorized terminal/session with the same frozen command.

## Progress

```sh
cd /Users/erwin/Downloads/codespace/experiments/deepseek-local-20261002-v3/automationbench/MFlow
python3 scripts/automation_experiment.py --benchmark automationbench --status --run runs/automationbench-deepseek-flash-local-20261002-v3

cd /Users/erwin/Downloads/codespace/experiments/deepseek-local-20261002-v3/hle/MFlow
python3 scripts/automation_experiment.py --benchmark hle --status --run runs/hle-deepseek-flash-local-20261002-v3
```

The corresponding start commands, run from those frozen directories with the private `.env` exported, are:

```sh
python3 scripts/automation_experiment.py --benchmark automationbench --run runs/automationbench-deepseek-flash-local-20261002-v3 --concurrency 16 --legacy-concurrency 2 --port 8297 --resume
python3 scripts/automation_experiment.py --benchmark hle --run runs/hle-deepseek-flash-local-20261002-v3 --concurrency 4 --legacy-concurrency 1 --port 8299 --resume
```

Do not launch a second supervisor while the recorded one is active. `jobs.json` distinguishes running, retrying and completed methods. Per-task results, model progress and usage records remain in the run directory. Search scores are provisional; report frozen full-test results separately.

Shared assets previously verified: 577 AutomationBench files, 359 HLE files and 188 upstream baseline source files. Offline regression checks are engineering evidence, not benchmark performance. The required `scripts/sync_hb.sh` attempt cannot complete while SSH is unavailable; canonical hb source consistency is **not confirmed** for these local changes.

## Per-round test protocol

After all five full validation repetitions of a round finish, the controller exports a frozen candidate. The runner launches one observer per method concurrently with search; each observer uses the **entire** held-out split (600 AutomationBench / 2300 HLE), then drains the next completed round. Episode concurrency remains 16 / 4 respectively, with memory admission. This can add another 16 / 4 tasks per method while its search is active. A backlog waits without dropping rounds. This is worker scheduling, not a round or token cap.

- MFlow exports `MFlow/search/round-candidates/round-N.json`; AFlow exports `AFlow/round-candidates/round-N.json` with workflow hashes.
- Scores, responses and diagnostics stay in `<method>/round-tests/round-N/`. AFlow execution IDs use `observe-round/`, so worlds, answer checkpoints and cost rows are separate from search and final test.
- Neither optimizer reads these results. Parent sampling, mutation, convergence and final selection use search scores only. Do not tune prompts or choose a model/round from the observed test results; a subsequent test-informed revision requires a new holdout for an unbiased claim.
- After convergence, both methods still run a **fresh final full test** of the search-selected candidate under `<method>/test/`. The runner stays alive until all observers and final methods complete.
- Status includes `roundTests` with round, progress, score, output and purpose. MFlow observer cost is separate; baseline `roundTests` cost is a subset of total test transport cost and must not be added twice. Unknown-usage estimates are not actual tokens.
- Saved candidate/manifest hashes prevent mixed resumes. Observer failure retries its own scope; model/transport worlds are not shared with search. A dead bridge is restarted before failed methods resume.

The historical MATH runner also exports full-validation candidates and supports independent full 486-task observers. Its existing one-pass validation protocol is unchanged; it is not a new five-pass comparison with the current two benchmarks.

## Task adaptation and reusable checks

| Framework | AutomationBench | HLE |
| --- | --- | --- |
| MFlow | Five distinct initial MAS structures; API dependency planning, exact field values, shared-state inspection/repair and open-ended subagent creation | Subject-specific reasoning, image evidence, exact computation/retrieval and complementary subagents; evidence-based stopping instructions |
| AFlow | Three static initialization structures; native operators with effect-based ensemble selection, `[PLAN ONLY]` stages without action tools | Academic solve/plan/review prompts, evidence-based ensemble selection, image propagation and Ditto Python |
| DyLAN | Native debate/pruning; math examples removed, task-specific consensus/reporting, ranking without tools | Academic debate with normalized final answer consensus; preserve Explanation/Answer/Confidence |
| EvoAgent | Native expert creation/retention/refinement; API-specific complementary roles and effect summaries | Subject-specific expert generation, independent methods and calibrated final answer contract |
| AutoAgents | Native manager/observers/actions; actor API capabilities explicit, schema repair cannot execute tools | Academic/image/tool capabilities explicit to manager and actors; native role/control schemas preserved |

All use the published Ditto provider/tool interfaces. MFlow also retains existing task-specific DROP, GSM8K, MATH and Python-code answer contracts. The five-method comparison runner supports MATH, AutomationBench and HLE; this does not claim complete baseline integrations for the other managed datasets.

Verified in this revision: Node suite **116 passed, 3 skipped**, native adapter suite **21 passed**. Run `npm test` and `../MFlow-baselines/.venv-legacy/bin/python baselines/test_adapters.py`. They cover native stage execution, published-package tool worlds, transport failures, candidate integrity, round queue draining/restart, final-test isolation and search-selection independence. Full paid results remain pending while experiments run; a live process or a scripted provider is not a passing benchmark result.
