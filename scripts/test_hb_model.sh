#!/usr/bin/env bash
# Isolated shell check: no SSH, credentials or model requests.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'python3 -c '\''import shutil,sys; shutil.rmtree(sys.argv[1])'\'' "$scratch"' EXIT
mkdir "$scratch/scripts"
cp "$root/scripts/hb-model.sh" "$scratch/scripts/"
printf '%s\n' 'MFLOW_MODEL=qwen3.5-9b' 'MFLOW_PROVIDER_OPTIONS=qwen-options' > "$scratch/.env.qwen"
printf '%s\n' 'MFLOW_MODEL=deepseek-flash' 'MFLOW_PROVIDER_OPTIONS=deepseek-options' > "$scratch/.env.deepseek"
MFLOW_MODEL=previous bash "$scratch/scripts/hb-model.sh" deepseek python3 -c 'import os; assert os.environ["MFLOW_MODEL"]=="deepseek-flash"; assert os.environ["MFLOW_PROVIDER_OPTIONS"]=="deepseek-options"'
bash "$scratch/scripts/hb-model.sh" qwen python3 -c 'import os; assert os.environ["MFLOW_MODEL"]=="qwen3.5-9b"'
if bash "$scratch/scripts/hb-model.sh" invalid true 2>/dev/null; then exit 1; fi
echo 'Model profile selection passed'
