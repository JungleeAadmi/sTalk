#!/usr/bin/env bash
# sTalk rollback script
# Restores:
#  - DB backup
#  - uploads backup
#  - VAPID backup
#  - systemd VAPID drop-in
# Useful when an update breaks something.

set -euo pipefail

info(){ printf "\033[1;34mℹ️  %s\033[0m\n" "$*"; }
ok(){   printf "\033[1;32m✅ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m⚠️  %s\033[0m\n" "$*"; }
err(){  printf "\033[1;31m❌ %s\033[0m\n" "$*"; exit 1; }

BACKUP_DIR="${BACKUP_DIR:-/root}"
DEFAULT_CANDIDATES=( "/opt/stalk" "/opt/sTalk" "/opt/sTalk-v2" "/opt/sTalk-*" )
SERVICE_CANDIDATES=( "stalk" "sTalk" )

APP_DIR="${APP_DIR:-}"

# Detect install directory
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

if [ -z "$APP_DIR" ]; then
  found=$(find /opt -maxdepth 1 -type d -iname "*stalk*" -print -quit 2>/dev/null || true)
  [ -n "$found" ] && APP_DIR="$found"
fi

[ -z "$APP_DIR" ] && err "Could not detect sTalk install directory."

APP_DIR="$(readlink -f "$APP_DIR")"
DB_FILE="$APP_DIR/database/stalk.db"
UPLOADS_DIR="$APP_DIR/uploads"
VAPID_FILE="$APP_DIR/.vapid.json"
SYSTEMD_DROPIN="/etc/systemd/system/stalk.service.d/vapid.conf"

info "Using APP_DIR = $APP_DIR"

# Find newest backups
DB_BAK=$(ls -1t ${BACKUP_DIR}/stalk.db.*.bak 2>/dev/null | head -n1 || true)
UP_BAK=$(ls -1t ${BACKUP_DIR}/stalk-uploads-*.tar.gz 2>/dev/null | head -n1 || true)
VAPID_BAK=$(ls -1t ${BACKUP_DIR}/.vapid.json.*.bak 2>/dev/null | head -n1 || true)
DROPIN_BAK=$(ls -1t ${BACKUP_DIR}/vapid.conf.*.bak 2>/dev/null | head -n1 || true)

info "Found DB backup: ${DB_BAK:-none}"
info "Found uploads backup: ${UP_BAK:-none}"
info "Found VAPID backup: ${VAPID_BAK:-none}"
info "Found systemd drop-in backup: ${DROPIN_BAK:-none}"

read -p "Proceed with rollback? (y/N): " -n1 CONF
echo ""
[[ ! $CONF =~ ^[Yy]$ ]] && err "Aborted."

# Stop service if exists
SERVICE=""
for s in "${SERVICE_CANDIDATES[@]}"; do
  if systemctl list-unit-files | grep -q "^$s.service"; then
    SERVICE="$s"
    break
  fi
done

if [ -n "$SERVICE" ]; then
  info "Stopping ${SERVICE}.service ..."
  systemctl stop "${SERVICE}.service" || warn "Could not stop service"
fi

# Restore DB
if [ -n "${DB_BAK}" ]; then
  info "Restoring database..."
  cp -f "$DB_BAK" "$DB_FILE"
  ok "DB restored"
fi

# Restore uploads
if [ -n "${UP_BAK}" ]; then
  info "Restoring uploads (this may take time)..."
  rm -rf "$UPLOADS_DIR"
  mkdir -p "$APP_DIR/uploads"
  tar -xzf "$UP_BAK" -C "$APP_DIR"
  ok "Uploads restored"
fi

# Restore VAPID keys
if [ -n "${VAPID_BAK}" ]; then
  info "Restoring VAPID keys..."
  cp -f "$VAPID_BAK" "$VAPID_FILE"
  chmod 600 "$VAPID_FILE"
  ok "VAPID restored"
fi

# Restore systemd drop-in
if [ -n "${DROPIN_BAK}" ]; then
  info "Restoring systemd VAPID drop-in..."
  mkdir -p "$(dirname "$SYSTEMD_DROPIN")"
  cp -f "$DROPIN_BAK" "$SYSTEMD_DROPIN"
  chmod 644 "$SYSTEMD_DROPIN"
  ok "systemd drop-in restored"
  systemctl daemon-reload || true
fi

# Restart service
if [ -n "$SERVICE" ]; then
  info "Starting ${SERVICE}.service..."
  systemctl start "${SERVICE}.service" || warn "Could not start service"
fi

ok "Rollback complete."
info "You may now test your installation."
