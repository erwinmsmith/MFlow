#!/usr/bin/env bash
# Run a command with one explicit server model profile; never rewrites the default .env.
set -euo pipefail
if [[ $# -lt 2 ]]; then
  echo 'Usage: bash scripts/hb-model.sh qwen|deepseek COMMAND [ARGS...]' >&2
  exit 2
fi
case "$1" in qwen|deepseek) profile="$1" ;; *) echo 'Choose qwen or deepseek' >&2; exit 2 ;; esac
shift
cd "$(dirname "$0")/.."
set -a
source ".env.$profile"
set +a
exec "$@"
