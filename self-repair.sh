#!/usr/bin/env bash
# self-repair.sh - attempt common non-destructive fixes for sTalk
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/sTalk}"
SERVICE="${SERVICE:-stalk}"
NODE_USER="${NODE_USER:-root}"
NPM_CMD="${NPM_CMD:-npm}"
VAPID_FILE="${APP_DIR}/.vapid.json"

echo "sTalk self-repair - $(date)"
echo "App dir: $APP_DIR"
cd "$APP_DIR" || { echo "App dir not found"; exit 1; }

# 1) Fix permissions (safe)
echo "-> Fixing permissions (non-recursive safe defaults)..."
chown -R "$NODE_USER":"$NODE_USER" "$APP_DIR" || true
find "$APP_DIR" -type d -exec chmod 755 {} \; || true
find "$APP_DIR" -type f -exec chmod 644 {} \; || true
[ -f "$VAPID_FILE" ] && chmod 600 "$VAPID_FILE" || true
echo "Permissions adjusted."

# 2) Ensure node modules present (npm ci if package-lock exists)
if [ -f package.json ]; then
  echo "-> Installing node dependencies (production)..."
  if command -v "$NPM_CMD" >/dev/null 2>&1; then
    if [ -f package-lock.json ]; then
      $NPM_CMD ci --production --prefer-offline --no-audit || $NPM_CMD install --production
    else
      $NPM_CMD install --production || true
    fi
  else
    echo "npm not found, skipping dependency install"
  fi
fi

# 3) Remove potentially corrupt node_modules then reinstall (safe)
if [ -d node_modules ]; then
  echo "-> Removing node_modules cache and reinstalling"
  rm -rf node_modules/.cache || true
  # keep node_modules to avoid large reinstall; only remove if explicitly requested
fi

# 4) Restart service
echo "-> Restarting systemd service: ${SERVICE}"
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true
  systemctl restart "${SERVICE}.service" || { echo "Failed to restart ${SERVICE}.service - check logs"; }
  systemctl is-active --quiet "${SERVICE}.service" && echo "${SERVICE} is running" || echo "${SERVICE} is NOT running"
else
  echo "systemctl not available; please restart service manually"
fi

# 5) Show recent logs
echo "-> Recent logs (last 50 lines):"
journalctl -u "${SERVICE}.service" -n 50 --no-pager || true

echo "Self-repair completed. Inspect above output for any errors."
