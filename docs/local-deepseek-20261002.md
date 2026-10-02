# Local DeepSeek comparisons — 2026-10-02

AutomationBench and HLE run locally after hb stopped accepting SSH connections. Both use DeepSeek Flash and published Ditto 0.1.1. The five methods run concurrently in each comparison; every method completes search/development before its full held-out test. Existing search rules, prompts, data partitions and execution protection are retained.

| Benchmark | MFlow episodes | AFlow episodes | Workers per DyLAN / EvoAgent / AutoAgents | Ditto bridge | Full split |
| --- | ---: | ---: | ---: | ---: | --- |
| AutomationBench | 16 | 16 | 2 | 8297 | 200 development / 600 test |
| HLE | 4 | 4 | 1 | 8299 | 200 search / 2300 test |

These are concurrent task counts, not token, round or context budgets. Native graphs can make additional concurrent model calls. All calls still use Ditto's published model and tool interfaces. HLE is the existing custom multimodal holdout with the Flash judge and filtered web retrieval, not an official full-test/no-tools score. Local web retrieval no longer depends on an SSH relay.

## Snapshots and provenance

The complete local runs live below `/Users/erwin/Downloads/codespace/experiments/deepseek-local-20261002-v2/`, with separate `automationbench/MFlow` and `hle/MFlow` snapshots. Each has its own registry-installed Node dependencies, private `.env`, output and bridge. Data stays in the shared `codespace/Benchmarks`; Python environments are reused, and copied upstream baseline source files are hash-verified. No Ditto checkout or linked runtime is used.

Server checkpoints could not be downloaded. Local quality results therefore start afresh, and must not be merged with server evaluations. Old server data/results remain intact. A local one-shot launchd job, `io.mflow.hb-deepseek-retire.20261002`, retries SSH until it can stop only the old DeepSeek AutomationBench/HLE services; it does not stop Qwen. Its receipt is `/Users/erwin/Library/Logs/MFlow/hb-deepseek-retire-20261002.log`. Until that receipt confirms shutdown, the old server's execution state remains unknown.

Local v1 is an archived startup attempt. It exposed transient connection failures that native AutoAgents retry handlers could wrap and score as task errors. Preserve its rows, unknown-usage requests and costs as startup overhead; do not combine its quality rows with v2. No test task was used to make these repairs.

## Runtime repairs and supervision

- Baseline inference reuses MFlow's existing transient retry policy. Every attempt is still written to the shared cost ledger. HLE judging keeps its existing metered retry layer without nested retries.
- Shared bridge calls classify infrastructure failures consistently. A transport failure escapes native formatting/retry handlers and prevents a scored task row. Model-output failures remain quality evidence.
- In parallel mode an interrupted method resumes after 60 seconds. The bridge first releases that method's unfinished sessions through public Ditto runtime shutdown; saved checkpoints and other methods are preserved. MFlow retries add `--resume` once a manifest exists.
- The runner freezes effective search/baseline settings, ports and worker counts in the experiment manifest. Changing these refuses resume. macOS memory admission uses free/reclaimable pages instead of `/proc/meminfo`.

macOS denied launchd access to Downloads. Experiment supervisors instead run as detached processes started from the authorized local session, with `caffeinate` preventing idle sleep. They survive this chat ending; keep the Mac powered and connected. Each benchmark's sibling `start.sh` restarts a failed runner after 60 seconds, exits after completion, and `supervisor.json` records its process group. A reboot requires relaunching from the authorized terminal/session with the same frozen command.

## Progress

```sh
cd /Users/erwin/Downloads/codespace/experiments/deepseek-local-20261002-v2/automationbench/MFlow
python3 scripts/automation_experiment.py --benchmark automationbench --status --run runs/automationbench-deepseek-flash-local-20261002-v2

cd /Users/erwin/Downloads/codespace/experiments/deepseek-local-20261002-v2/hle/MFlow
python3 scripts/automation_experiment.py --benchmark hle --status --run runs/hle-deepseek-flash-local-20261002-v2
```

The corresponding start commands, run from those frozen directories with the private `.env` exported, are:

```sh
python3 scripts/automation_experiment.py --benchmark automationbench --run runs/automationbench-deepseek-flash-local-20261002-v2 --concurrency 16 --legacy-concurrency 2 --port 8297 --resume
python3 scripts/automation_experiment.py --benchmark hle --run runs/hle-deepseek-flash-local-20261002-v2 --concurrency 4 --legacy-concurrency 1 --port 8299 --resume
```

Do not launch a second supervisor while the recorded one is active. `jobs.json` distinguishes running, retrying and completed methods. Per-task results, model progress and usage records remain in the run directory. Search scores are provisional; report frozen full-test results separately.

Checks: 577 AutomationBench files, 359 HLE files and 188 upstream baseline source files verified; real public Ditto Python/web tools passed a synthetic smoke check. Node suite: 115 passed, 3 skipped. Native adapter suite: 20 passed, including transport-error propagation and independent method resume. The required `scripts/sync_hb.sh` attempt cannot complete while SSH is unavailable; canonical hb source consistency is **not confirmed** for these local changes.
