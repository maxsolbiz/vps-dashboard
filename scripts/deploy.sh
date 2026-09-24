#!/bin/bash
# Manual deploy for the VPS Control Panel. Run over SSH only, never from
# cron or a webhook:
#   ssh -i ~/.ssh/meezan_vps root@178.105.109.19 "bash /root/vps-dashboard/scripts/deploy.sh"
# Aborts without restarting anything if the pull or the syntax check fails.
set -euo pipefail
cd /root/vps-dashboard

echo "==> git fetch + pull (ff-only)"
git fetch origin
git pull --ff-only origin main

LOCK_CHANGED=0
if git diff --name-only HEAD@{1} HEAD 2>/dev/null | grep -q '^package-lock.json$'; then
  LOCK_CHANGED=1
fi

if [ "$LOCK_CHANGED" = "1" ]; then
  echo "==> package-lock.json changed: npm ci --omit=dev"
  npm ci --omit=dev
else
  echo "==> package-lock.json unchanged: skipping npm ci"
fi

echo "==> node --check server.js"
node --check server.js

echo "==> pm2 reload vps-control-panel"
pm2 reload vps-control-panel --update-env

echo "==> health check"
HEALTH="$(curl -sf http://127.0.0.1:8787/api/health)"
echo "$HEALTH"
echo "DEPLOY OK"
