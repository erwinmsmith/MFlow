# hb / Jetson deployment

Local working tree: `/Users/erwin/Downloads/codespace/AFlow`.
Server checkout: `hb:/home/b/project/MFlow`.
Sync local changes with `bash scripts/sync_hb.sh`; this uses SSH/rsync and npm's registry, never GitHub on hb.
It builds locally, uploads using content checksums, rebuilds on hb, and verifies every included file's content and path afterward.
`bash scripts/sync_hb.sh --check` checks consistency without uploading. It exits unsuccessfully for different, missing or extra source files.
The same exclusions apply to transfer and verification: credentials, Git metadata, dependencies, build output, datasets and experiment results stay outside source comparison.
Run experiments from independent immutable snapshots under `~/project/experiments/`; canonical code sync does not update their executing code. Original local source/data remain in place.

## Runtime

Node 24.21.0 ARM64, npm 11, registry `@codesoul-co/ditto@0.1.1`.
The server `.env` selects `http://127.0.0.1:11434/v1`, `qwen3.5-9b`, a dummy local SDK key,
and `chat_template_kwargs.enable_thinking=false`.
MFlow freezes these provider options in newly created bundles.
`configs/hb-baselines.json` selects the same model for AFlow, DyLAN, AutoAgents and EvoAgent;
both their bridge and Python controllers read `MFLOW_BASELINE_PROTOCOL`.
Formal MATH results go to `runs/hb-qwen-math-20260930-v2`; earlier transport/pilot results remain separate.
Both MFlow and the baseline bridge consume the published Ditto stream. Its public `fetch` injection
uses a dedicated Undici dispatcher with HTTP headers/body waiting limits disabled; Ditto/caller
AbortSignal still controls cancellation. This avoids Node's implicit 300-second cutoff while
requests queue behind the four local inference slots. Other HTTP requests retain their defaults.
The MATH AFlow Programmer retains its pinned upstream `run_code`, executed through public Ditto
`INTERACTION.ACT.TOOL` and the existing isolated Python tool. Its ARM64 image pins NumPy 2.0.2,
pandas 2.2.3 and SymPy 1.14.0; the immutable image ID is recorded in both hb baseline protocols.
The uploaded archive and build/verification manifest are outside code at `~/project/tools/aflow-python/`.

### DeepSeek profile

The server also has `.env.deepseek`, using the existing local DeepSeek key, `https://api.deepseek.com`,
and `deepseek-flash`. It is private (mode 600), excluded from Git and ordinary code sync.
`.env.qwen` stores the local Qwen profile; the default `.env` remains Qwen.
Select the profile for **each command** (including baseline bridge and controllers):

```sh
cd ~/project/MFlow
export PATH="$HOME/.local/bin:$PATH"
bash scripts/hb-model.sh qwen npm run mflow -- doctor
bash scripts/hb-model.sh deepseek npm run mflow -- doctor
# Start only when an experiment is explicitly requested:
bash scripts/hb-model.sh deepseek npm run mflow -- search --benchmark math \
  --config configs/hb-deepseek-aflow-search.json --out runs/hb-deepseek-math-NEW
bash scripts/hb-model.sh deepseek node baselines/bridge.mjs
# Another terminal, with the same explicit profile:
bash scripts/hb-model.sh deepseek ../MFlow-baselines/.venv-legacy/bin/python baselines/run.py DyLAN --phase test
```

The DeepSeek profile clears Qwen-specific request options, retains disabled thinking for consistency with existing experiments,
and selects `configs/hb-deepseek-baselines.json` for all four baseline controllers.
Baseline output is isolated in `runs/hb-deepseek-flash-baselines-math`.
Its 393,216-token output ceiling follows the [official API contract](https://api-docs.deepseek.com/api/create-chat-completion/);
input and output still share the model context. No paid generation or experiment was run when enabling this profile.
Switching profiles does not convert a frozen bundle: create a new search/bundle for each model.
The server's authenticated `GET /models` check passed for `deepseek-flash`; profile selection and baseline configuration checks passed without generation requests.

The parallel inference profile has four slots with 65,536 context tokens per slot.
The configured output ceiling is 65,536; input and output share that context, so this is not a guaranteed completion length.
For longer context, `~/project/llm-server/profile.sh long` selects one 262,144-token slot.
Change experiment concurrency/output settings together with the profile. Full-length generation has not been tested.

MFlow's Python tool retains its Docker isolation. Install Docker on hb:

```sh
sudo bash ~/project/MFlow/scripts/hb-bootstrap-root.sh
# Reconnect SSH, then load the already-transferred ARM64 image:
docker load -i ~/project/tools/python-arm64.tar
```

## Prepared assets

- MATH: shared assets under `~/project/Benchmarks/collections/aflow-3f457218/math`; fixed 119 search / 486 test questions, original official MATH test files retained separately. Hashes match the repository lock. No resplitting.
- Baselines: pinned files and upstream license/readme metadata under `~/project/MFlow-baselines/sources`; isolated ARM64 Python environments `.venv-aflow` and `.venv-legacy` use the repository requirement pins.
- [HLE official evaluator](https://github.com/centerforaisafety/hle): official reference source and separate environment `~/project/Benchmarks/environments/hle`. The authorized download now contains all 2,500 questions at `~/project/Benchmarks/collections/hle/raw/`, with SHA-256 verified against local assets. MFlow supports full question images and a separately named 200/2300 custom holdout; see [HLE comparison and progress](hle-experiment.md).
- [Zapier AutomationBench](https://github.com/zapier/AutomationBench): `~/project/Benchmarks/collections/automationbench/official`, revision `4a8e1061254004d9dac807054eed33fad7d1ff14`; official 1.0.6 environment installed and 577 managed files verified. Locked views contain 200 simple development tasks and 600 public held-out tasks. MFlow and all four baseline adapters use official API tools registered through public Ditto. See [AutomationBench protocol and progress commands](automationbench-experiment.md).

Downloaded transfer archives are verified on hb before their temporary local copies are removed.
Transfer checksums are saved in `~/project/transfer-manifest.json`.

## Checks and later experiment commands

```sh
ssh hb
export PATH="$HOME/.local/bin:$PATH"
cd ~/project/MFlow
set -a; source .env; set +a
npm run mflow -- doctor
python3 benchmark-hub/bench.py --root "$BENCHMARK_HOME" verify --name math
../MFlow-baselines/.venv-legacy/bin/python baselines/test_adapters.py
```

The unified runner also supports MATH with the selected private model profile. Run from an immutable
snapshot with independent pinned baseline sources next to it. Qwen uses port 8198; DeepSeek uses 8197.
Start under a user service with `sg docker -c` so Docker group membership is applied:

```sh
bash scripts/hb-model.sh qwen python3 scripts/automation_experiment.py --benchmark math --sequential
bash scripts/hb-model.sh qwen python3 scripts/automation_experiment.py --benchmark math --status
```

MFlow and AFlow search on all 119 fixed validation tasks and freeze their selected artifact before
testing all 486 fixed test tasks. DyLAN, EvoAgent and AutoAgents directly test the same 486 tasks.
Qwen MFlow validates/evaluates with concurrency 4; the inference server admits 4 simultaneous slots.
When DeepSeek also runs on the 16 GB Jetson, `--sequential` queues complete methods to reduce resident
Python processes: MFlow search/test, AFlow search/test, DyLAN, EvoAgent, AutoAgents. Each method keeps
its original algorithm and within-method concurrency. The manifest records this scheduling choice.
The runner records each method's stage and exit code, and `--resume` verifies the immutable manifest.

To start only a new MFlow search explicitly:

```sh
npm run mflow -- search --benchmark math --config configs/hb-aflow-search.json \
  --out runs/hb-qwen-math-NEW --source ../MFlow-baselines/sources/AFlow \
  --python ../MFlow-baselines/.venv-aflow/bin/python
```

Baseline bridge, then baseline controllers in another shell with the same exported `.env`:

```sh
node baselines/bridge.mjs
# Examples for a later explicit experiment; these make local model calls:
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py DyLAN --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py EvoAgent --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py AutoAgents --phase test
../MFlow-baselines/.venv-aflow/bin/python baselines/aflow.py --phase search-test
```

Reuse no DeepSeek bundles or historical results for Qwen. Each immutable snapshot has its own bridge, output and profile; assign different ports when running both models. Each baseline controller preserves its existing scheduling.

Validation on 2026-09-30: local `npm test` passed 102 tests (3 skipped); hb passed 97 (8 skipped, including unavailable Docker checks). The baseline offline suite passed all 8 tests on hb with the Qwen protocol. MFlow's Ditto provider and the baseline bridge each returned `OK` from the real local Qwen server on a synthetic prompt. This checks transport only, not model quality or benchmark scores. The temporary bridge was stopped; its logs are isolated in `runs/hb-transport-smoke`.

The previous deployment used a validated snapshot while local benchmark changes were incomplete. The current deployment follows the local working tree and requires matching content checksums. `AGENTS.md` requires future code changes to finish with a successful sync and verification. Local benchmark integration files are synchronized as code; downloading or registering additional datasets is a separate operation.
