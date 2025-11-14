#!/usr/bin/env bash
# sTalk rollback script (safe)
# Restores the most recent backups for:
#  - SQLite DB (database/stalk.db)
#  - uploads archive (uploads/)
#  - .vapid.json (if present)
#  - systemd VAPID drop-in (vapid.conf)
#
# Usage (recommended as root):
# sudo bash rollback.sh
#
# The script will:
#  - auto-detect installation under /opt
#  - show the chosen backup files and ask for confirmation
#  - stop the service (if present), restore files, reload systemd and start service
#  - be conservative (won't overwrite if no matching backup found)

set -euo pipefail

# --- helpers ---
info(){ printf "\033[1;34mℹ️  %s\033[0m\n" "$*"; }
ok(){   printf "\033[1;32m✅ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m⚠️  %s\033[0m\n" "$*"; }
err(){  printf "\033[1;31m❌ %s\033[0m\n" "$*"; exit 1; }

# --- config / detection ---
BACKUP_DIR="${BACKUP_DIR:-/root}"
DEFAULT_CANDIDATES=( "/opt/stalk" "/opt/sTalk" "/opt/sTalk-v2" "/opt/sTalk-*" )
SERVICE_CANDIDATES=( "stalk" "sTalk" )
SYSTEMD_DROPIN="/etc/systemd/system/stalk.service.d/vapid.conf"
APP_DIR="${APP_DIR:-}"

# Find app dir if not provided
if [ -z "$APP_DIR" ]; then
  for cand in "${DEFAULT_CANDIDATES[@]}"; do
    for match in $(compgen -G "$cand" 2>/dev/null || true); do
      if [ -d "$match" ]; then
        APP_DIR="$match"
        break 2
      fi
    done
  done
fi

if [ -z "${APP_DIR:-}" ]; then
  found=$(find /opt -maxdepth 1 -type d -iname "*stalk*" -print -quit 2>/dev/null || true)
  [ -n "$found" ] && APP_DIR="$found"
fi

[ -z "${APP_DIR:-}" ] && err "Could not detect sTalk install directory. Set APP_DIR=/path/to/sTalk and re-run."

APP_DIR="$(readlink -f "$APP_DIR")"
DB_FILE="$APP_DIR/database/stalk.db"
UPLOADS_DIR="$APP_DIR/uploads"
VAPID_FILE="$APP_DIR/.vapid.json"

info "Using APP_DIR = $APP_DIR"
info "Looking for backups in: $BACKUP_DIR"

# --- find newest backup files (if any) ---
DB_BAK=$(ls -1t "${BACKUP_DIR}/stalk.db."*.bak 2>/dev/null | head -n1 || true)
UP_BAK=$(ls -1t "${BACKUP_DIR}/stalk-uploads-"*.tar.gz 2>/dev/null | head -n1 || true)
VAPID_BAK=$(ls -1t "${BACKUP_DIR}/.vapid.json."*.bak 2>/dev/null | head -n1 || true)
DROPIN_BAK=$(ls -1t "${BACKUP_DIR}/vapid.conf."*.bak 2>/dev/null | head -n1 || true)

info "DB backup: ${DB_BAK:-<none>}"
info "Uploads backup: ${UP_BAK:-<none>}"
info "VAPID backup: ${VAPID_BAK:-<none>}"
info "Systemd drop-in backup: ${DROPIN_BAK:-<none>}"

# Confirm
read -r -p $'Proceed with rollback using the above backups? (type "yes" to proceed): ' CONF
if [ "$CONF" != "yes" ]; then
  err "Aborted by user. Type \"yes\" to proceed."
fi

# --- detect service name ---
SERVICE=""
for s in "${SERVICE_CANDIDATES[@]}"; do
  if systemctl list-unit-files --type=service | grep -q "^${s}.service" 2>/dev/null; then
    SERVICE="$s"
    break
  fi
done
if [ -z "$SERVICE" ]; then
  warn "No systemd unit found for expected names; will skip service stop/start."
fi

# Stop service if present
if [ -n "$SERVICE" ]; then
  info "Stopping ${SERVICE}.service (if active)..."
  systemctl stop "${SERVICE}.service" 2>/dev/null || warn "Failed to stop ${SERVICE}.service (continuing)"
  sleep 1
fi

# --- restore DB ---
if [ -n "${DB_BAK}" ]; then
  info "Restoring DB: ${DB_BAK} -> ${DB_FILE}"
  mkdir -p "$(dirname "$DB_FILE")"
  cp -f "${DB_BAK}" "${DB_FILE}" || err "Failed to restore DB"
  ok "Database restored"
else
  warn "No DB backup found to restore"
fi

# --- restore uploads ---
if [ -n "${UP_BAK}" ]; then
  info "Restoring uploads archive: ${UP_BAK} -> ${APP_DIR}"
  # remove existing uploads dir (be careful)
  if [ -d "${UPLOADS_DIR}" ]; then
    info "Removing existing uploads directory before restore"
    rm -rf "${UPLOADS_DIR}" || warn "Could not remove existing uploads (permission?)"
  fi
  mkdir -p "${APP_DIR}"
  tar -xzf "${UP_BAK}" -C "${APP_DIR}" || err "Failed to extract uploads archive"
  ok "Uploads restored"
else
  warn "No uploads backup found to restore"
fi

# --- restore VAPID file ---
if [ -n "${VAPID_BAK}" ]; then
  info "Restoring VAPID file: ${VAPID_BAK} -> ${VAPID_FILE}"
  cp -f "${VAPID_BAK}" "${VAPID_FILE}" || err "Failed to restore VAPID"
  chmod 600 "${VAPID_FILE}" || true
  ok "VAPID restored"
else
  info "No VAPID backup found (skipping)"
fi

# --- restore systemd drop-in ---
if [ -n "${DROPIN_BAK}" ]; then
  info "Restoring systemd drop-in: ${DROPIN_BAK} -> ${SYSTEMD_DROPIN}"
  mkdir -p "$(dirname "${SYSTEMD_DROPIN}")"
  cp -f "${DROPIN_BAK}" "${SYSTEMD_DROPIN}" || warn "Failed to copy drop-in (permission?)"
  chmod 644 "${SYSTEMD_DROPIN}" || true
  systemctl daemon-reload || warn "systemctl daemon-reload failed"
  ok "Systemd drop-in restored"
else
  info "No systemd drop-in backup found (skipping)"
fi

# --- start service ---
if [ -n "$SERVICE" ]; then
  info "Starting ${SERVICE}.service..."
  systemctl start "${SERVICE}.service" 2>/dev/null || warn "Failed to start ${SERVICE}.service"
  # brief wait and status
  sleep 2
  if systemctl is-active --quiet "${SERVICE}.service"; then
    ok "${SERVICE}.service is active"
  else
    warn "${SERVICE}.service is not active after start attempt; check logs: sudo journalctl -u ${SERVICE}.service -n 200"
  fi
fi

ok "Rollback finished. Verify your app and check logs if anything unexpected."
info "If you restored VAPID or systemd drop-in, and service fails to start, run:"
echo "  sudo journalctl -u ${SERVICE}.service -n 200 --no-pager"
