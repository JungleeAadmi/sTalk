#!/usr/bin/env bash
# Safe update script for sTalk
# - preserves database and uploads
# - backups current DB & uploads
# - pulls latest git code from origin/main
# - installs dependencies and runs build if present
# - runs migrations if scripts/migrate.sh exists
# - restarts detected systemd service
#
# Run as root (recommended):
# sudo bash -c "$(wget -qO- https://raw.githubusercontent.com/JungleeAadmi/sTalk/main/update.sh)"

set -euo pipefail

# --- Config ---
GIT_BRANCH="${GIT_BRANCH:-main}"
BACKUP_DIR="${BACKUP_DIR:-/root}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
DEFAULT_CANDIDATES=( "/opt/stalk" "/opt/sTalk" "/opt/sTalk-v2" "/opt/sTalk-*" )
SERVICE_NAME_CANDIDATES=( "stalk" "sTalk" )
SYSTEMD_DIR="/etc/systemd/system"

# --- helpers ---
info(){ printf "\033[1;34mℹ️  %s\033[0m\n" "$*"; }
ok(){   printf "\033[1;32m✅ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m⚠️  %s\033[0m\n" "$*"; }
err(){  printf "\033[1;31m❌ %s\033[0m\n" "$*"; }

# --- find app dir (detect common locations) ---
APP_DIR="${APP_DIR:-}"

if [ -z "$APP_DIR" ]; then
  for cand in "${DEFAULT_CANDIDATES[@]}"; do
    # expand globs safely
    for match in $(compgen -G "$cand" 2>/dev/null || true); do
      if [ -d "$match" ]; then
        APP_DIR="$match"
        break 2
      fi
    done
  done
fi

if [ -z "${APP_DIR:-}" ]; then
  # last resort: case-insensitive find under /opt
  found=$(find /opt -maxdepth 1 -type d -iname "*stalk*" -print -quit 2>/dev/null || true)
  if [ -n "$found" ]; then
    APP_DIR="$found"
  fi
fi

if [ -z "${APP_DIR:-}" ]; then
  err "No sTalk installation found under /opt. Set APP_DIR=/path/to/sTalk and re-run."
  exit 1
fi

APP_DIR="$(readlink -f "$APP_DIR")"

DB_FILE="$APP_DIR/database/stalk.db"
UPLOADS_DIR="$APP_DIR/uploads"

info "Using app directory: $APP_DIR"
info "DB path (if exists): $DB_FILE"
info "Uploads path (if exists): $UPLOADS_DIR"

# --- auto-backup database and uploads ---
if [ -f "$DB_FILE" ]; then
  DB_BAK="${BACKUP_DIR}/stalk.db.${TIMESTAMP}.bak"
  info "Backing up DB -> $DB_BAK"
  cp "$DB_FILE" "$DB_BAK"
  ok "DB backup created"
else
  warn "No DB file found at $DB_FILE (skipping DB backup)."
fi

if [ -d "$UPLOADS_DIR" ]; then
  UP_BAK="${BACKUP_DIR}/stalk-uploads-${TIMESTAMP}.tar.gz"
  info "Backing up uploads (may be large) -> $UP_BAK"
  tar -czf "$UP_BAK" -C "$APP_DIR" uploads
  ok "Uploads backup created"
else
  warn "No uploads directory found at $UPLOADS_DIR (skipping uploads backup)."
fi

# --- find service name to stop/start ---
SERVICE_NAME=""
for s in "${SERVICE_NAME_CANDIDATES[@]}"; do
  if systemctl list-unit-files --type=service | grep -q "^${s}.service" 2>/dev/null; then
    SERVICE_NAME="$s"
    break
  fi
done
# fallback: pick first candidate
if [ -z "$SERVICE_NAME" ]; then
  SERVICE_NAME="${SERVICE_NAME_CANDIDATES[0]}"
  warn "No systemd unit detected for expected names. Will try service: $SERVICE_NAME"
else
  info "Detected systemd service: ${SERVICE_NAME}.service"
fi

# --- stop service safely ---
if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null || systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service" 2>/dev/null; then
  info "Stopping service ${SERVICE_NAME}.service..."
  systemctl stop "${SERVICE_NAME}.service" || warn "Failed to stop ${SERVICE_NAME}.service (continuing)"
else
  warn "Service ${SERVICE_NAME}.service not active or not present (continuing)"
fi

# --- git update (non-destructive) ---
if [ -d "$APP_DIR/.git" ]; then
  info "Updating code from git (branch: $GIT_BRANCH)..."
  pushd "$APP_DIR" >/dev/null
  git fetch --all --prune
  git checkout "$GIT_BRANCH" || git checkout -B "$GIT_BRANCH"
  git reset --hard "origin/${GIT_BRANCH}"
  popd >/dev/null
  ok "Code updated"
else
  warn "No .git directory in $APP_DIR — manual deploys not supported by this script. Please deploy manually."
fi

# --- node deps & build ---
if [ -f "$APP_DIR/package.json" ]; then
  info "Installing Node dependencies (npm ci --prefer-offline --no-audit --production)..."
  pushd "$APP_DIR" >/dev/null
  # prefer npm ci for reproducible installs; fallback to npm install
  if command -v npm >/dev/null 2>&1; then
    npm ci --production --prefer-offline --no-audit || npm install --production
  else
    warn "npm not found; skipping dependency install"
  fi
  popd >/dev/null
  ok "Dependencies step finished"
fi

# --- optional build step ---
if [ -f "$APP_DIR/package.json" ] && grep -q "\"build\"" "$APP_DIR/package.json"; then
  info "Running build (npm run build)..."
  pushd "$APP_DIR" >/dev/null
  npm run build || warn "Build failed. Check build scripts and logs."
  popd >/dev/null
  ok "Build step finished"
fi

# --- migrations hook ---
if [ -x "$APP_DIR/scripts/migrate.sh" ]; then
  info "Running migration script: scripts/migrate.sh"
  bash "$APP_DIR/scripts/migrate.sh" || warn "Migration script failed (check manually)"
  ok "Migration hook executed"
else
  info "No migration hook found at scripts/migrate.sh (skipping)"
fi

# --- fix permissions (optional) ---
# If your service runs as www-data or another user, uncomment and set accordingly:
# chown -R www-data:www-data "$APP_DIR"

# --- start service ---
info "Starting service ${SERVICE_NAME}.service..."
systemctl start "${SERVICE_NAME}.service" || warn "Failed to start ${SERVICE_NAME}.service; check logs"

# --- show logs ---
info "Recent logs (last 100 lines) for ${SERVICE_NAME}.service:"
journalctl -u "${SERVICE_NAME}.service" -n 100 --no-pager || true

ok "Update completed. DB and uploads preserved under $APP_DIR (backups in $BACKUP_DIR if created)."
