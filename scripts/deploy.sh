#!/bin/bash
# Manual deploy for the VPS Control Panel. Run over SSH only, never from
# cron or a webhook:
#   ssh -i ~/.ssh/meezan_vps root@178.105.109.19 "bash /root/vps-dashboard/scripts/deploy.sh"
# Aborts without restarting anything if the pull or the syntax check fails.
#
# NOTE: this script rewrites itself on every pull (git replaces the file while
# bash is still reading it), so after a successful pull we re-exec the freshly
# pulled copy instead of continuing in a half-read file. OLD is carried across
# the re-exec so the package-lock comparison stays correct.
set -euo pipefail
cd /root/vps-dashboard

if [ "${PANEL_DEPLOY_PHASE2:-}" = "1" ]; then
  # Phase 2: the new script is already on disk. Use the OLD recorded before the
  # pull, skip pulling again, and finish the deploy.
  OLD="${PANEL_DEPLOY_OLD:?PANEL_DEPLOY_OLD missing}"
  NEW="$(git rev-parse HEAD)"
  echo "==> continuing deploy $OLD -> $NEW"
else
  # Phase 1: pull, then hand over to the new copy of this script.
  OLD="$(git rev-parse HEAD)"
  echo "==> starting from $OLD"
  echo "==> git fetch + pull (ff-only)"
  git fetch origin
  git pull --ff-only origin main
  NEW="$(git rev-parse HEAD)"
  echo "==> $OLD -> $NEW"
  if [ "$OLD" = "$NEW" ]; then
    echo "==> already up to date, nothing to do"
    exit 0
  fi
  export PANEL_DEPLOY_OLD="$OLD"
  export PANEL_DEPLOY_PHASE2=1
  exec bash "$0" "$@"
fi

# Compare against the pre-pull HEAD (not HEAD@{1}, which may be older when
# the pull changed nothing or when several pulls happened in a row).
# NOTE: plain `git diff ... | grep -q` under `set -o pipefail` can misreport
# via SIGPIPE, so --quiet is used instead.
LOCK_CHANGED=0
if ! git diff --quiet "$OLD" "$NEW" -- package-lock.json; then
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

echo "==> pm2 startOrReload (applies ecosystem env changes; panel only)"
pm2 startOrReload ecosystem.config.js --only vps-control-panel --update-env

echo "==> health check (retrying up to 30s: the panel needs a moment to bind)"
HEALTH=""
for i in $(seq 1 30); do
  if HEALTH="$(curl -sf --max-time 3 http://127.0.0.1:8787/api/health)"; then
    break
  fi
  HEALTH=""
  sleep 1
done
if [ -z "$HEALTH" ]; then
  echo "HEALTH CHECK FAILED. Roll back with:"
  echo "  cd /root/vps-dashboard && git checkout $OLD && pm2 startOrReload ecosystem.config.js --only vps-control-panel --update-env"
  echo "  cd /root/vps-dashboard && git checkout main   # leave detached HEAD afterwards"
  exit 1
fi
echo "$HEALTH"
echo "DEPLOY OK"
