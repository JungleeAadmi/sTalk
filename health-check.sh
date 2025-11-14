#!/usr/bin/env bash
# health-check.sh - quick health diagnostics for sTalk
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/sTalk}"
SERVICE="${SERVICE:-stalk}"
PORT="${PORT:-3000}"
DB_FILE="${APP_DIR}/database/stalk.db"
UPLOADS_DIR="${APP_DIR}/uploads"
OUT="/tmp/stalk_health_$(date +%Y%m%d_%H%M%S).txt"

echo "sTalk Health Check - $(date)" > "$OUT"
echo "App dir: $APP_DIR" >> "$OUT"
echo

# 1) systemd service
echo "== Service status ($SERVICE) ==" >> "$OUT"
if command -v systemctl >/dev/null 2>&1; then
  systemctl status "${SERVICE}.service" --no-pager -n 20 >> "$OUT" 2>&1 || echo "Service not active/available" >> "$OUT"
else
  echo "systemctl not available" >> "$OUT"
fi

# 2) HTTP check /api/health
echo -e "\n== HTTP /api/health ==" >> "$OUT"
if command -v curl >/dev/null 2>&1; then
  if curl -sS -m 5 "http://localhost:${PORT}/api/health" >> "$OUT" 2>&1; then
    echo -e "\nOK: /api/health returned" >> "$OUT"
  else
    echo -e "\nWARN: /api/health did not respond on port ${PORT}" >> "$OUT"
  fi
else
  echo "curl not installed; skipping HTTP check" >> "$OUT"
fi

# 3) VAPID public key
echo -e "\n== HTTP /api/push/key ==" >> "$OUT"
if command -v curl >/dev/null 2>&1; then
  curl -sS -m 5 "http://localhost:${PORT}/api/push/key" | sed -n '1,6p' >> "$OUT" 2>&1 || echo "No push key or route" >> "$OUT"
fi

# 4) DB check
echo -e "\n== Database ==" >> "$OUT"
if [ -f "$DB_FILE" ]; then
  echo "DB exists: $DB_FILE" >> "$OUT"
  if command -v sqlite3 >/dev/null 2>&1; then
    echo "SQLite tables:" >> "$OUT"
    sqlite3 "$DB_FILE" ".tables" >> "$OUT" 2>&1 || echo "sqlite3 query failed" >> "$OUT"
    echo -e "\nRow counts (users/messages/file_uploads):" >> "$OUT"
    for q in "SELECT COUNT(*) from users;" "SELECT COUNT(*) from messages;" "SELECT COUNT(*) from file_uploads;"; do
      echo -n "$q " >> "$OUT"
      sqlite3 "$DB_FILE" "$q" >> "$OUT" 2>&1 || echo "NA" >> "$OUT"
    done
  else
    echo "sqlite3 not available. Install sqlite3 for deeper DB checks." >> "$OUT"
  fi
else
  echo "DB missing at $DB_FILE" >> "$OUT"
fi

# 5) uploads dir
echo -e "\n== Uploads ==" >> "$OUT"
if [ -d "$UPLOADS_DIR" ]; then
  echo "Uploads dir exists: $UPLOADS_DIR" >> "$OUT"
  du -sh "$UPLOADS_DIR"/* 2>/dev/null | head -n 20 >> "$OUT" || echo "Unable to list uploads detail" >> "$OUT"
else
  echo "Uploads missing at $UPLOADS_DIR" >> "$OUT"
fi

echo -e "\nHealth check saved to: $OUT"
cat "$OUT"
