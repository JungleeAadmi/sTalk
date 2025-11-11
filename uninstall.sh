#!/usr/bin/env bash
#
# sTalk Uninstaller - safe full uninstall script (keeps container intact)
# Detects common install directories (/opt/stalk or /opt/sTalk), supports backup,
# stops/disables systemd service, and removes app files and service unit.
#
# Usage:
#   sudo bash uninstall.sh
# or
#   sudo /path/to/uninstall.sh
#
set -euo pipefail

# === Configurable defaults ===
DEFAULT_CANDIDATES=( "/opt/stalk" "/opt/sTalk" "/opt/sTalk-v2" "/opt/sTalk-*")
SERVICE_NAME_CANDIDATES=( "stalk" "sTalk" )
SYSTEMD_DIR="/etc/systemd/system"
BACKUP_DIR="/root"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

# === Helper functions ===
info()    { printf "\033[1;34mℹ️  %s\033[0m\n" "$*"; }
ok()      { printf "\033[1;32m✅ %s\033[0m\n" "$*"; }
warn()    { printf "\033[1;33m⚠️  %s\033[0m\n" "$*"; }
err()     { printf "\033[1;31m❌ %s\033[0m\n" "$*"; }

# === 1) Determine APP_DIR ===
APP_DIR="${APP_DIR:-}"  # allow override via environment

if [ -z "$APP_DIR" ]; then
  for cand in "${DEFAULT_CANDIDATES[@]}"; do
    # shellcheck disable=SC2016
    for match in $(compgen -G "$cand" 2>/dev/null || true); do
      if [ -d "$match" ]; then
        APP_DIR="$match"
        break 2
      fi
    done
  done
fi

if [ -z "${APP_DIR:-}" ]; then
  # As a last resort, check any directory under /opt that case-insensitively matches "stalk"
  found=$(find /opt -maxdepth 1 -type d -iname "*stalk*" -print -quit 2>/dev/null || true)
  if [ -n "$found" ]; then
    APP_DIR="$found"
  fi
fi

if [ -z "${APP_DIR:-}" ]; then
  err "No sTalk installation directory found under /opt. If you installed elsewhere, set APP_DIR=/path/to/sTalk and re-run."
  exit 1
fi

# Normalize APP_DIR to absolute
APP_DIR="$(readlink -f "$APP_DIR")"

DB_PATH="$APP_DIR/database/stalk.db"
UPLOADS_PATH="$APP_DIR/uploads"

info "Detected app directory: $APP_DIR"
info "Database path (if present): $DB_PATH"
info "Uploads path (if present): $UPLOADS_PATH"

echo
warn "This script will REMOVE the application directory and (optionally) related service/config files."
read -r -p "Do you want to continue? This is irreversible. (y/N): " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  ok "Uninstall cancelled by user."
  exit 0
fi

# === 2) Backup option ===
read -r -p "Create a backup tarball of ${APP_DIR} to ${BACKUP_DIR}/stalk-backup-${TIMESTAMP}.tar.gz ? (recommended) (Y/n): " do_backup
BACKUP_FILE="$BACKUP_DIR/stalk-backup-${TIMESTAMP}.tar.gz"
if [[ -z "$do_backup" || "$do_backup" =~ ^[Yy]$ ]]; then
  if [ -d "$APP_DIR" ]; then
    info "Creating backup..."
    sudo tar -czf "${BACKUP_FILE}" -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
    ok "Backup created: ${BACKUP_FILE}"
  else
    warn "No application directory found to backup."
  fi
else
  info "Skipping backup as requested."
fi

# === 3) Stop & disable systemd services if present ===
for svc in "${SERVICE_NAME_CANDIDATES[@]}"; do
  unit="${svc}.service"
  if systemctl list-unit-files --type=service | grep -q "^${unit}" 2>/dev/null; then
    info "Found systemd unit: ${unit}"
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      info "Stopping ${unit}..."
      sudo systemctl stop "$unit" || warn "Failed to stop ${unit} (continuing)"
    fi
    info "Disabling ${unit}..."
    sudo systemctl disable "$unit" || warn "Failed to disable ${unit} (continuing)"
    # optionally remove later if present
  fi
done

# === 4) Remove app directory ===
if [ -d "$APP_DIR" ]; then
  info "Removing application directory: ${APP_DIR}"
  sudo rm -rf "$APP_DIR"
  ok "Removed ${APP_DIR}"
else
  warn "Application directory ${APP_DIR} not present (nothing to remove)."
fi

# === 5) Remove systemd unit files (for both service name variants) ===
systemd_reloaded=0
for svc in "${SERVICE_NAME_CANDIDATES[@]}"; do
  unitfile="${SYSTEMD_DIR}/${svc}.service"
  if [ -f "$unitfile" ]; then
    info "Removing systemd unit file: ${unitfile}"
    sudo rm -f "$unitfile"
    systemd_reloaded=1
  fi
done

if [ "$systemd_reloaded" -eq 1 ]; then
  info "Reloading systemd daemon..."
  sudo systemctl daemon-reload || warn "systemctl daemon-reload failed"
  ok "Systemd daemon reloaded"
fi

# === 6) Optional nginx config removal ===
NGINX_CONF1="/etc/nginx/sites-enabled/stalk"
NGINX_CONF2="/etc/nginx/sites-available/stalk"
NGINX_CONF3="/etc/nginx/sites-enabled/sTalk"
NGINX_CONF4="/etc/nginx/sites-available/sTalk"

nginx_found=0
for c in "$NGINX_CONF1" "$NGINX_CONF2" "$NGINX_CONF3" "$NGINX_CONF4"; do
  if [ -f "$c" ]; then
    nginx_found=1
    break
  fi
done

if [ "$nginx_found" -eq 1 ]; then
  echo
  read -r -p "Detected possible nginx config files (sites-available/enabled). Remove them? (y/N): " remove_nginx
  if [[ "$remove_nginx" =~ ^[Yy]$ ]]; then
    info "Removing nginx config files..."
    sudo rm -f "$NGINX_CONF1" "$NGINX_CONF2" "$NGINX_CONF3" "$NGINX_CONF4" || true
    # test and reload nginx if possible
    if command -v nginx >/dev/null 2>&1; then
      if sudo nginx -t >/dev/null 2>&1; then
        info "Reloading nginx..."
        sudo systemctl reload nginx || warn "Failed to reload nginx (check manually)"
      else
        warn "nginx config test failed after removal — please check /etc/nginx/ manually."
      fi
    fi
    ok "Nginx config removal attempted."
  else
    info "Skipping nginx config removal."
  fi
fi

# === 7) PM2 cleanup (if used) ===
if command -v pm2 >/dev/null 2>&1; then
  if pm2 list | grep -iq "stalk\|sTalk"; then
    echo
    read -r -p "PM2 entry for sTalk detected. Remove PM2 process and save? (y/N): " pm2_remove
    if [[ "$pm2_remove" =~ ^[Yy]$ ]]; then
      sudo pm2 delete "stalk" >/dev/null 2>&1 || true
      sudo pm2 delete "sTalk" >/dev/null 2>&1 || true
      sudo pm2 save >/dev/null 2>&1 || true
      ok "PM2 process removed (if present)."
    else
      info "Skipping PM2 removal."
    fi
  fi
fi

# === 8) npm cache cleanup (optional, safe) ===
if command -v npm >/dev/null 2>&1; then
  read -r -p "Run 'npm cache clean --force' to free npm cache? (y/N): " npm_clear
  if [[ "$npm_clear" =~ ^[Yy]$ ]]; then
    info "Cleaning npm cache (best-effort)..."
    sudo npm cache clean --force >/dev/null 2>&1 || warn "npm cache clean had issues (continuing)"
    ok "npm cache cleaned (best-effort)."
  else
    info "Skipping npm cache clean."
  fi
fi

# === 9) Final summary ===
echo
ok "Uninstallation/cleanup completed."
if [ -f "$BACKUP_FILE" ]; then
  ok "Backup (if created) is at: $BACKUP_FILE"
else
  info "No backup was created."
fi

echo
info "You can reinstall using your install command, e.g.:"
echo "  wget -qO- https://raw.githubusercontent.com/JungleeAadmi/sTalk/main/install.sh | sudo bash"

exit 0
