#!/usr/bin/env bash
# Run on hb: sudo bash ~/project/MFlow/scripts/hb-bootstrap-root.sh
set -euo pipefail
apt-get update
apt-get install -y docker.io
systemctl enable --now docker
usermod -aG docker b
# New SSH sessions will pick up the group; the inference service needs no restart.
