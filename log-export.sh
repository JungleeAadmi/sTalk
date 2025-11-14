#!/usr/bin/env bash
# log-export.sh - collect logs & minimal debug bundle for sTalk
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/sTalk}"
SERVICE="${SERVICE:-stalk}"
OUT_DIR="${OUT_DIR:-/root}"
TS="$(date +%Y%m%d_%H%M%S)"
OUT_FILE="${OUT_DIR}/stalk-logs-${TS}.tar.gz"
TMPDIR="$(mktemp -d /tmp/stalk-logs-XXXX)"

echo "Creating debug bundle: $OUT_FILE"
mkdir -p "$TMPDIR"

# 1) journal logs (last 500 lines)
if command -v journalctl >/dev/null 2>&1; then
  journalctl -u "${SERVICE}.service" -n 500 --no-pager > "${TMPDIR}/journal_${SERVICE}.log" 2>/dev/null || true
fi

# 2) node logs if any (common places)
if [ -d "/var/log" ]; then
  # pick any app-specific logs if exist
  cp -v /var/log/*stalk* "${TMPDIR}/" 2>/dev/null || true
fi

# 3) package.json & server.js & .vapid.json metadata (not private content)
for f in package.json server.js .vapid.json; do
  if [ -f "${APP_DIR}/${f}" ]; then
    cp -v "${APP_DIR}/${f}" "${TMPDIR}/" 2>/dev/null || true
  fi
done

# 4) small DB summary (counts)
if [ -f "${APP_DIR}/database/stalk.db" ] && command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "${APP_DIR}/database/stalk.db" "SELECT name FROM sqlite_master WHERE type='table';" > "${TMPDIR}/db_tables.txt" 2>/dev/null || true
  sqlite3 "${APP_DIR}/database/stalk.db" "SELECT COUNT(*) FROM users;" > "${TMPDIR}/db_users_count.txt" 2>/dev/null || true
fi

# 5) node/npm versions and environment
node -v 2>/dev/null > "${TMPDIR}/node_version.txt" || echo "node not found" > "${TMPDIR}/node_version.txt"
npm -v 2>/dev/null > "${TMPDIR}/npm_version.txt" || echo "npm not found" > "${TMPDIR}/npm_version.txt"
env | grep -E 'VAPID|JWT|PORT|DB_PATH' > "${TMPDIR}/env_snippet.txt" || true

# bundle
tar -czf "$OUT_FILE" -C "$TMPDIR" . || { echo "Failed to create archive"; exit 1; }

# cleanup tmp
rm -rf "$TMPDIR"

echo "Created: $OUT_FILE"
ls -lh "$OUT_FILE"
