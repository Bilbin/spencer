#!/usr/bin/env bash
# Redeploys the relay bundle (and pinned croc) to the VPS and restarts both services.
# First-time setup (users, /etc/*/ env files, units, nginx vhost, cert) is described in README.md.
# Usage: scripts/deploy-relay.sh [ssh-target]   (default ubuntu@pjalv.com)
set -euo pipefail
TARGET="${1:-ubuntu@pjalv.com}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node scripts/build-relay.mjs
[ -x .bin/croc ] || scripts/fetch-croc.sh
ssh "$TARGET" 'mkdir -p ~/spencer-deploy'
scp -q dist/relay/relay.mjs .bin/croc deploy/spencer-relay.service deploy/croc-relay.service "$TARGET":spencer-deploy/
ssh "$TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
cd ~/spencer-deploy
sudo install -D -m 0644 relay.mjs /opt/spencer-relay/relay.mjs
sudo install -D -m 0755 croc /opt/croc/croc
sudo install -m 0644 spencer-relay.service croc-relay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl restart spencer-relay croc-relay
sleep 2
systemctl is-active spencer-relay croc-relay
curl -fsS http://127.0.0.1:8820/healthz && echo " (relay healthy)"
REMOTE
curl -fsS https://spencer.pjalv.com/healthz && echo " (public endpoint healthy)"
