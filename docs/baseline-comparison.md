# MATH baseline comparison: historical budgeted experiment

This archived protocol had a shared 30M budget. The user subsequently removed it; see [the unrestricted rerun](baseline-rerun.md). Current benchmark adapters are indexed in [the documentation guide](README.md).

The experiment executed pinned official control code from adjacent MFlow-baselines/sources checkouts. MFlow retained adapters, locks, and necessary patches. Results describe these adapted implementations, not the original papers' model/configuration results.

## Historical settings and differences

AFlow MATH: 119 validation / 486 test, unchanged order and membership; search/selection uses validation only. DeepSeek Flash, thinking disabled, temperature 0. Output allowance 4096; episode budget 24000; shared pilot/search/test budget 30,000,000 including prior MFlow work. Grading used frozen grade_math.py/math-verify. Python/NumPy seed 42 was used where applicable; provider determinism was not guaranteed. Registry Ditto 0.1.1 executed and metered requests.

The byte-based reservation estimate (serialized UTF-8 request + output + 1024) could block a request before measured consumption reached 24000, especially in AutoAgents. That stop is not algorithmic convergence.

| Method | Official entry and adaptation |
| --- | --- |
| AFlow | Optimizer._optimize_graph, initial validation plus at most four candidates; search allowance 2,280,742 tokens; Custom/ScEnsemble; ties choose earlier round; freeze workflow/prompt hashes before test |
| DyLAN | runpy execution of code/MATH/llmlp_gen_math_listwise_deeper_markov.py; four agents, three rounds, consensus and top-two pruning; retained few-shot; temporary task-file adapter and common grader |
| AutoAgents | Explorer/Manager/observers/Group/CustomAction; ten outer rounds; local metered model bridge, no long-term memory/web search in this historical run; native Print/WriteFile/FinalOutput; fresh team per task |
| EvoAgent | spp/util_func.py collaboration_func; expert creation/checking/solving/integration, three iterations; logic answer format adapted to boxed MATH answers; common transport |

AutoAgents/EvoAgent lacked native MATH loaders. EvoAgent's prompt-variable declaration required the recorded patch, without changing collaboration. Tool conditions differed: MFlow arithmetic, no AFlow Programmer in this run, and no AutoAgents web search. DyLAN retained its native few-shot. Report accuracy, cost, and budget-stop rate rather than attributing all differences to spawn.

On budget exhaustion, DyLAN used native extraction/majority over completed solver responses; EvoAgent used the latest completed integration or initial answer; AutoAgents used its last published Response, preferring Final Output; incomplete AFlow workflows returned empty answers. Truncated tasks remained in the denominator. Normal completion used native output.

## Provenance, credentials, and accounting

Sources are pinned in baselines/sources.lock.json. Run manifests freeze adapters, grader, data, Ditto, and Python dependencies. Python clients use the localhost bridge, not real API keys; only the Node bridge reads private .env. Logs, environments, keys, and raw outputs stay out of Git.

Historical accounting started with 3,543,561 prior tokens and reserved 24000 per remaining MFlow test task. All baseline successes, failures, and pilots were charged; unknown usage retained reservations. AFlow optimizer calls used the search budget rather than the episode budget. An early bridge incorrectly applied the episode cap, and its initial-only diagnostic was archived separately with costs retained. Public bridge ledgers, not AFlow's nominal currency CSV, are the token authority.

/status spent referred to new baseline usage; remaining also subtracted history and MFlow reservations. A running bridge must not be restarted casually: in-flight requests may lack terminal usage. One process owns the port.

Direct-test runners skip completed IDs on resume. Ordinary native parsing failures were recorded as zero-score execution errors; transport faults stopped for investigation. An AFlow NumPy-integer JSON failure after 119 initial evaluations was repaired by casting cumulative cost to float and rebuilding metadata without purchasing those evaluations again. Recovery retains manifest history/reasons and does not tune prompts or graders using test output. Partial tests are never reported as complete.

## Environment and execution

Use separate Python 3.11 environments for AFlow's Pydantic 2/OpenAI 1 and legacy methods' Pydantic 1/OpenAI 0.28. The following source setup is still useful; do not overwrite a running checkout:
```sh
python3 - <<'PY'
import json, subprocess
from pathlib import Path
root = Path.cwd()
for name, item in json.loads((root/'baselines/sources.lock.json').read_text()).items():
    target = root.parent/'MFlow-baselines/sources'/name
    if target.exists():
        raise SystemExit(f'{target} exists; inspect it before replacing')
    subprocess.run(['git','clone',item['repository'],str(target)],check=True)
    subprocess.run(['git','-C',str(target),'checkout','--detach',item['commit']],check=True)
    if 'patch' in item:
        subprocess.run(['git','-C',str(target),'apply',str(root/'baselines'/item['patch'])],check=True)
PY
uv venv --python 3.11 ../MFlow-baselines/.venv-legacy
uv pip install --python ../MFlow-baselines/.venv-legacy/bin/python -r baselines/requirements-legacy.txt
uv venv --python 3.11 ../MFlow-baselines/.venv-aflow
uv pip install --python ../MFlow-baselines/.venv-aflow/bin/python -r baselines/requirements-aflow.txt
```
Prepare Node 24, npm dependencies, data, grader environments, and a private .env as documented in the main README. Historical accounting constants/paths above are not defaults for a new experiment.

```sh
node baselines/bridge.mjs
# Separate terminals sharing that bridge:
../MFlow-baselines/.venv-aflow/bin/python baselines/aflow.py --phase search-test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py DyLAN --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py AutoAgents --phase test
../MFlow-baselines/.venv-legacy/bin/python baselines/run.py EvoAgent --phase test
```

Full test contains all 486 tasks and does not accept --limit. A two-task `--phase pilot --limit 2` reads validation only and establishes compatibility, not quality. Offline checks use baselines/test_adapters.py and npm test, without paid model calls.
