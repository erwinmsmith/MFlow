# hb experiment recovery — 2026-10-01

## Current runs

The following services resume complete protocols. Retain the local Qwen model service. Methods run sequentially within each comparison; LLM calls within a method remain concurrent. Waiting methods are queued, not additional active failures. Search has no experimental token/round/agent/depth quota or additional Context truncation; execution protection remains.

| Comparison | Immutable snapshot below `/home/b/project/experiments/` | User service | Episodes / full split |
| --- | --- | --- | --- |
| DeepSeek Flash / AutomationBench | `deepseek-automation-20261001-v4/MFlow` | `mflow-deepseek-automation-20261001-v4.service` | MFlow/AFlow 8; others 1 worker; 200 development / 600 test |
| DeepSeek Flash / HLE | `deepseek-hle-20260930-v1/MFlow` | `mflow-deepseek-hle-20260930-v1.service` | MFlow/AFlow 2; others 1 worker; 200 search / 2300 test |
| Qwen / MATH | `qwen-math-20260930-v2/MFlow` | `hb-qwen-math-20261001-resume.service` | Existing 4-slot configuration; 119 search / 486 test |

AutomationBench and HLE execute code at commit `41f293a`, with published Ditto 0.1.1. Qwen retains its original `5bc5d8f` runtime and candidates. Later canonical source synchronization does not replace any executing snapshot. Both DeepSeek services restart failed runners after 60 seconds and resume committed evaluations. Repeated provider/infrastructure faults still require repair; a process restart is not evidence of correctness.

HLE is the documented **custom multimodal, tool-augmented holdout with a Flash judge**, not the official full-test/no-tools score. Its data verification covers 359 files; search has 28 image questions and test has 314. Actor answers checkpoint before judge execution. Test remains separate from search and selection.

## Faults and repairs

- The standby baseline bridge lacked Node on its systemd PATH. Its readiness check also expected `/proc/PID/comm` to equal `node`; Node 24 reports `MainThread`. Set PATH and check the executable path. The old bridge and replacement-client services are now stopped; v4 owns port 8197, HLE uses 8199, and Qwen uses 8198.
- Old provider exceptions discarded HTTP error bodies. The shared public-fetch injection now retains status/code/message. An explicit HTTP 400 context-capacity rejection becomes `MODEL_CONTEXT_LIMIT`, recoverable within the task through the searched policy. Authentication, HTTP/network and service faults remain infrastructure failures. Model-output failures in native baseline adapters remain scored task evidence rather than transport outages.
- A synthetic non-benchmark request reproduced the provider's combined input/output limit. The old AutomationBench 400 did not save its body, so its precise cause cannot be established retrospectively. The application does not truncate input or reduce the configured output allowance. General capacity-aware provider support remains [DITTO-007](ditto-requirements.md) for a future published Ditto release.
- Retaining Qwen leaves limited RAM on the 16 GB server. AutomationBench now admits 8 concurrent MFlow/AFlow episodes, HLE 2, and the three other methods use one worker each. Sequential method scheduling and delayed bridge startup reduce resident memory. Dataset coverage and native search/optimization rules are unchanged.
- HLE's actual public Ditto `web_search` preflight exposed a server network failure: direct DuckDuckGo timed out. The same backend succeeds through the existing local proxy, forwarded by SSH. No search provider, filtering rule or actor prompt was changed. The systemd HLE drop-in sets `DDGS_PROXY` and checks connectivity before starting.

The previous SSH outage and historical Qwen server restarts have no confirmed root cause; they must not be labelled OOM without evidence.

## Preserved evidence

At AutomationBench cutover, completed evaluations were MFlow 1999, AFlow 3129, DyLAN 54, EvoAgent 61 and corrected AutoAgents 41. Original outputs/manifests remain archived; new `recovery.json` receipts record hashes and migration details. Candidates, prompts, MAS programs, data and grading identities were checked before reusing rows. Package-lock differences were restricted to the public Undici dispatcher dependency; existing Ditto and other registry package entries were unchanged.

The corrected AFlow/AutoAgents outputs and full shared cost ledger were copied. Thirteen interrupted legacy requests were explicitly settled as unknown usage. Forty-one AutoAgents world checkpoint keys were mapped to the new execution namespace with unchanged checkpoint bytes. Old incorrect-capability AutoAgents quality rows remain excluded; their costs remain retained. No rows were deleted for poor quality, and test data was not used for repair or selection.

HLE's temporary network-repair stop retains its first completed search evaluation and interrupted actor costs. Tasks without a completed answer checkpoint resume execution; saved answers resume grading. No test evaluations had started at recovery.

## Progress and recovery commands

```sh
ssh hb 'cd /home/b/project/experiments/deepseek-automation-20261001-v4/MFlow; python3 scripts/automation_experiment.py --status'
ssh hb 'cd /home/b/project/experiments/deepseek-hle-20260930-v1/MFlow; python3 scripts/automation_experiment.py --benchmark hle --status'
ssh hb 'cd /home/b/project/experiments/qwen-math-20260930-v2/MFlow; python3 scripts/automation_experiment.py --benchmark math --status'
ssh hb 'systemctl --user show mflow-deepseek-automation-20261001-v4.service mflow-deepseek-hle-20260930-v1.service hb-qwen-math-20261001-resume.service --property=Id --property=ActiveState --property=SubState --property=NRestarts'
```

The Qwen frozen runner retains historical failed job labels for methods waiting to resume; the active service and MFlow progress identify the current run. New DeepSeek runners reset those pending methods to `queued`. `currentValidation` is one candidate/pass, not final test accuracy. Costs include earlier work and unknown-usage calls. After successful search/development each method automatically evaluates its full held-out split.

The HLE proxy is a local launchd service at `/Users/erwin/Library/LaunchAgents/io.mflow.hb-search-proxy.plist`, label `io.mflow.hb-search-proxy`. It reconnects SSH and forwards **only a server-loopback port** `127.0.0.1:17897` to the existing local proxy `127.0.0.1:7897`. The Mac, its proxy and network must stay online during HLE retrieval. Model requests continue directly from hb to DeepSeek. The HLE systemd drop-in is `~/.config/systemd/user/mflow-deepseek-hle-20260930-v1.service.d/web-search.conf`. These operational files are outside code/data sync. After HLE completes, remove the drop-in and unload the relay with:

```sh
launchctl bootout gui/$(id -u) /Users/erwin/Library/LaunchAgents/io.mflow.hb-search-proxy.plist
```

Verification: Node suite 115 passed / 3 skipped / 0 failed; native adapter suite 18 passed. The public Ditto web-tool smoke uses a synthetic academic query, not any benchmark question or answer. Fixture checks and transport preflights establish wiring, not benchmark quality. Canonical source changes require successful `bash scripts/sync_hb.sh` checksum verification; running snapshots remain separate.
