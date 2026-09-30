#!/usr/bin/env bash
# Live check using an owned temporary file, never edits application code or credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
# Environment may be a symlink; a trailing slash in the exclude would delete it.
ssh hb 'test -x ~/project/MFlow/.benchmark-venv/bin/python'
bash scripts/sync_hb.sh --check
probe="$(mktemp .hb-sync-probe.XXXXXX)"
cleanup() {
  python3 -c 'from pathlib import Path; import sys; Path(sys.argv[1]).unlink(missing_ok=True)' "$probe"
  ssh hb "python3 -c 'from pathlib import Path; (Path.home()/\"project/MFlow/$probe\").unlink(missing_ok=True)'"
}
trap cleanup EXIT
printf '1111\n' > "$probe"
rsync -a "$probe" hb:/home/b/project/MFlow/
bash scripts/sync_hb.sh --check
# Keep size and timestamp identical: the production checksum check must detect this.
ssh hb "python3 -c 'import os; from pathlib import Path; p=Path.home()/\"project/MFlow/$probe\"; s=p.stat(); p.write_bytes(b\"2222\\n\"); os.utime(p,ns=(s.st_atime_ns,s.st_mtime_ns))'"
if differences="$(bash scripts/sync_hb.sh --check 2>&1)"; then
  echo 'Checksum verification missed changed content' >&2; exit 1
fi
[[ "$differences" == *"$probe"* ]]
echo 'Checksum check detected changed content with identical size and timestamp'
