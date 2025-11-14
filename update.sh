#!/usr/bin/env bash
# Safe update script for sTalk (v2)
# - preserves database, uploads, and VAPID keys
# - backups current DB & uploads & .vapid.json
# - pulls latest git code from origin/main (or $GIT_BRANCH)
# - installs dependencies and runs build if present
# - runs migrations if scripts/migrate.sh exists
# - reloads systemd if VAPID/systemd drop-in changed
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
TMPDIR="$(mktemp -d -t stalk-update-XXXX)"
trap 'rm -rf "${TMPDIR}"' EXIT

# --- helpers ---
info(){ printf "\033[1;34mℹ️  %s\033[0m\n" "$*"; }
ok(){   printf "\033[1;32m✅ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m⚠️  %s\033[0m\n" "$*"; }
err(){  printf "\033[1;31m❌ %s\033[0m\n" "$*"; }

# --- find app dir (detect common locations) ---
APP_DIR="${APP_DIR:-}"

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
VAPID_FILE="$APP_DIR/.vapid.json"
SYSTEMD_DROPIN_DIR="/etc/systemd/system/stalk.service.d"
SYSTEMD_VAPID_CONF="${SYSTEMD_DROPIN_DIR}/vapid.conf"

info "Using app directory: $APP_DIR"
info "DB path (if exists): $DB_FILE"
info "Uploads path (if exists): $UPLOADS_DIR"
info "Checking for existing VAPID at: $VAPID_FILE"

# --- backup existing VAPID (if any) ---
VAPID_BAK="${BACKUP_DIR}/.vapid.json.${TIMESTAMP}.bak"
if [ -f "${VAPID_FILE}" ]; then
  info "Backing up existing VAPID -> ${VAPID_BAK}"
  cp -f "${VAPID_FILE}" "${VAPID_BAK}" || warn "Failed to backup VAPID (permission?)"
  ok "VAPID backup created"
fi

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

# --- detect systemd service name ---
SERVICE_NAME=""
for s in "${SERVICE_NAME_CANDIDATES[@]}"; do
  if systemctl list-unit-files --type=service | grep -q "^${s}.service" 2>/dev/null; then
    SERVICE_NAME="$s"
    break
  fi
done
if [ -z "$SERVICE_NAME" ]; then
  SERVICE_NAME="${SERVICE_NAME_CANDIDATES[0]}"
  warn "No systemd unit detected for expected names. Will try service: $SERVICE_NAME"
else
  info "Detected systemd service: ${SERVICE_NAME}.service"
fi

# --- stop service safely if active ---
if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null || systemctl list-unit-files | grep -q "^${SERVICE_NAME}.service" 2>/dev/null; then
  info "Stopping service ${SERVICE_NAME}.service..."
  systemctl stop "${SERVICE_NAME}.service" || warn "Failed to stop ${SERVICE_NAME}.service (continuing)"
else
  warn "Service ${SERVICE_NAME}.service not active or not present (continuing)"
fi

# --- preserve existing systemd VAPID drop-in if present ---
DROPIN_BAK=""
if [ -f "${SYSTEMD_VAPID_CONF}" ]; then
  DROPIN_BAK="${BACKUP_DIR}/vapid.conf.${TIMESTAMP}.bak"
  info "Backing up existing systemd drop-in -> ${DROPIN_BAK}"
  cp -f "${SYSTEMD_VAPID_CONF}" "${DROPIN_BAK}" || warn "Failed to backup systemd drop-in"
  ok "Systemd drop-in backup created"
fi

# --- git update (non-destructive) ---
if [ -d "$APP_DIR/.git" ]; then
  info "Updating code from git (branch: $GIT_BRANCH)..."
  pushd "$APP_DIR" >/dev/null
  git fetch --all --prune
  # ensure branch exists locally
  if git rev-parse --verify "origin/${GIT_BRANCH}" >/dev/null 2>&1; then
    git checkout "$GIT_BRANCH" || git checkout -B "$GIT_BRANCH"
    git reset --hard "origin/${GIT_BRANCH}"
  else
    warn "Remote branch origin/${GIT_BRANCH} not found, staying on current branch"
  fi
  popd >/dev/null
  ok "Code updated"
else
  warn "No .git directory in $APP_DIR — manual deploys not supported by this script. Please deploy manually."
fi

# --- node deps & build ---
if [ -f "$APP_DIR/package.json" ]; then
  info "Installing Node dependencies (npm ci --prefer-offline --no-audit --production preferred)..."
  pushd "$APP_DIR" >/dev/null
  if command -v npm >/dev/null 2>&1; then
    # try npm ci first for reproducible builds; fallback to npm install
    if npm ci --production --prefer-offline --no-audit --silent >/dev/null 2>&1; then
      ok "npm ci completed"
    else
      warn "npm ci failed — falling back to npm install"
      npm install --production --silent || warn "npm install failed"
    fi
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
  if npm run build --silent >/dev/null 2>&1; then
    ok "Build completed"
  else
    warn "Build failed or returned non-zero status; check build logs"
  fi
  popd >/dev/null
fi

# --- migrations hook ---
if [ -x "$APP_DIR/scripts/migrate.sh" ]; then
  info "Running migration script: scripts/migrate.sh"
  if bash "$APP_DIR/scripts/migrate.sh"; then
    ok "Migration script executed"
  else
    warn "Migration script failed (check manually)"
  fi
else
  info "No migration hook found at scripts/migrate.sh (skipping)"
fi

# --- restore VAPID (if repo removed it) ---
if [ -f "${VAPID_BAK}" ] && [ ! -f "${VAPID_FILE}" ]; then
  info "Restoring previously backed up VAPID to application dir..."
  cp -f "${VAPID_BAK}" "${VAPID_FILE}" || warn "Failed to restore VAPID file"
  chown --reference="${APP_DIR}" "${VAPID_FILE}" 2>/dev/null || true
  chmod 600 "${VAPID_FILE}" || true
  ok "VAPID restored"
fi

# --- reload systemd if drop-in exists or was created by upgrade ---
RELOAD_SYSTEMD=false
if [ -d "${SYSTEMD_DROPIN_DIR}" ] || [ -f "${SYSTEMD_VAPID_CONF}" ]; then
  info "Ensuring systemd drop-in location exists: ${SYSTEMD_DROPIN_DIR}"
  mkdir -p "${SYSTEMD_DROPIN_DIR}" || true
  RELOAD_SYSTEMD=true
fi

# If repo now contains a .vapid.json (new), ensure systemd drop-in exists and set flags
if [ -f "${VAPID_FILE}" ]; then
  # attempt to extract keys and write drop-in if not present (safe, minimal)
  if [ ! -f "${SYSTEMD_VAPID_CONF}" ]; then
    info "Creating systemd drop-in to inject VAPID env vars"
    # Extract safe values (public/private) using sed (do not rely on jq/node here)
    VAPID_PUBLIC="$(sed -n 's/.*\"publicKey\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' "${VAPID_FILE}" || true)"
    VAPID_PRIVATE="$(sed -n 's/.*\"privateKey\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' "${VAPID_FILE}" || true)"
    if [ -n "${VAPID_PUBLIC}" ] && [ -n "${VAPID_PRIVATE}" ]; then
      cat > "${SYSTEMD_VAPID_CONF}" <<EOF
[Service]
Environment=VAPID_PUBLIC_KEY=${VAPID_PUBLIC}
Environment=VAPID_PRIVATE_KEY=${VAPID_PRIVATE}
EOF
      chmod 644 "${SYSTEMD_VAPID_CONF}" || true
      RELOAD_SYSTEMD=true
      ok "Wrote systemd drop-in for VAPID"
    else
      warn "Could not parse VAPID keys to write systemd drop-in; skipping drop-in creation"
    fi
  fi
fi

if [ "$RELOAD_SYSTEMD" = true ]; then
  info "Reloading systemd daemon to pick up any drop-ins..."
  systemctl daemon-reload || warn "systemctl daemon-reload failed"
fi

# --- start service ---
info "Starting service ${SERVICE_NAME}.service..."
if systemctl start "${SERVICE_NAME}.service"; then
  ok "Service start requested"
else
  warn "Failed to start ${SERVICE_NAME}.service (check logs)"
fi

# --- show logs ---
info "Recent logs (last 200 lines) for ${SERVICE_NAME}.service:"
journalctl -u "${SERVICE_NAME}.service" -n 200 --no-pager || true

ok "Update completed. DB and uploads preserved under $APP_DIR (backups in $BACKUP_DIR if created)."
