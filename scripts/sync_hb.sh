#!/usr/bin/env bash
# Local working tree is authoritative. Remote environments and results stay local to hb.
set -euo pipefail
cd "$(dirname "$0")/.."
filters=(
  --exclude='.git/' --include='.env.example' --exclude='.env' --exclude='.env.*'
  --exclude='node_modules/' --exclude='dist/' --exclude='runs/'
  --exclude='.benchmark-venv' --exclude='.benchmark-sandbox-*/'
  --exclude='data/benchmarks' --exclude='data/prepared/'
  --exclude='__pycache__/' --exclude='*.log' --exclude='.DS_Store'
)
verify() {
  local differences
  differences="$(rsync -rcln --delete --itemize-changes --out-format='%i %n%L' \
    "${filters[@]}" ./ hb:/home/b/project/MFlow/)"
  if [[ -n "$differences" ]]; then
    printf 'Source mismatch:\n%s\n' "$differences" >&2
    return 1
  fi
  echo 'Local and hb source files match (content checksums and paths verified)'
}
if [[ "${1:-}" == '--check' && $# -eq 1 ]]; then verify; exit; fi
if [[ $# -ne 0 ]]; then echo 'Usage: bash scripts/sync_hb.sh [--check]' >&2; exit 2; fi
npm run build
rsync -azc --delete --itemize-changes "${filters[@]}" ./ hb:/home/b/project/MFlow/
ssh hb 'export PATH="$HOME/.local/bin:$PATH"; cd ~/project/MFlow; npm ci --ignore-scripts && python3 -c '\''import shutil; shutil.rmtree("dist", ignore_errors=True)'\'' && npm run build'
verify
