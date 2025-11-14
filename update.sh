#!/usr/bin/env bash
# Safe update script for sTalk (v3)
# - preserves database, uploads, and VAPID keys
# - backups current DB, uploads, .vapid.json and current code (tar)
# - pulls latest git code from origin/$GIT_BRANCH
# - installs dependencies and runs build if present
# - runs migrations if scripts/migrate.sh exists
# - creates/updates systemd drop-in with VAPID env vars
# - reloads systemd when drop-in changed and restarts service (with retries)
#
# Usage (recommended as root):
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
LOCK_FD=200
LOCK_FILE="/var/lock/stalk-update.lock"
trap 'rm -rf "${TMPDIR}"' EXIT

# --- Acquire exclusive lock so multiple updates don't collide ---
# Use literal FD 200 to avoid shell parsing ambiguity
exec 200>"${LOCK_FILE}"
if ! flock -n 200; then
  printf "\033[1;31m❌ Another update process is running. Exiting.\033[0m\n"
  exit 1
fi

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
CODE_BACKUP="${BACKUP_DIR}/stalk-code-${TIMESTAMP}.tar.gz"

info "Using app directory: $APP_DIR"
info "DB path (if exists): $DB_FILE"
info "Uploads path (if exists): $UPLOADS_DIR"
info "Checking for existing VAPID at: $VAPID_FILE"

# --- backup existing VAPID (if any) ---
VAPID_BAK="${BACKUP_DIR}/.vapid.json.${TIMESTAMP}.bak"
if [ -f "${VAPID_FILE}" ]; then
  info "Backing up existing VAPID -> ${VAPID_BAK}"
  if cp -f "${VAPID_FILE}" "${VAPID_BAK}"; then ok "VAPID backup created"; else warn "Failed to backup VAPID (permission?)"; fi
fi

# --- auto-backup database and uploads ---
if [ -f "$DB_FILE" ]; then
  DB_BAK="${BACKUP_DIR}/stalk.db.${TIMESTAMP}.bak"
  info "Backing up DB -> $DB_BAK"
  cp -f "$DB_FILE" "$DB_BAK"
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

# --- backup current code (non-destructive) ---
if [ -d "$APP_DIR" ]; then
  info "Backing up current application code -> ${CODE_BACKUP}"
  tar -C "$(dirname "$APP_DIR")" -czf "${CODE_BACKUP}" "$(basename "$APP_DIR")" || warn "Code backup failed"
  ok "Code backup created (may be large)"
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

# --- stop service safely if active (with timeout) ---
stop_service() {
  if systemctl is-active --quiet "${SERVICE_NAME}.service" 2>/dev/null; then
    info "Stopping service ${SERVICE_NAME}.service..."
    systemctl stop "${SERVICE_NAME}.service" || warn "systemctl stop returned non-zero"
    # wait up to 10s for stop
    for i in {1..10}; do
      if ! systemctl is-active --quiet "${SERVICE_NAME}.service"; then
        ok "Service stopped"
        return 0
      fi
      sleep 1
    done
    warn "Service did not stop promptly"
  else
    info "Service not active (no need to stop)"
  fi
}
stop_service

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
  git fetch --all --prune --quiet
  if git ls-remote --exit-code --heads origin "${GIT_BRANCH}" >/dev/null 2>&1; then
    # checkout or create local branch tracking origin
    if git rev-parse --verify "$GIT_BRANCH" >/dev/null 2>&1; then
      git checkout "$GIT_BRANCH" --quiet
    else
      git checkout -b "$GIT_BRANCH" --track "origin/$GIT_BRANCH" --quiet || git checkout -B "$GIT_BRANCH"
    fi
    git reset --hard "origin/${GIT_BRANCH}" --quiet
    ok "Code updated to origin/${GIT_BRANCH}"
  else
    warn "Remote branch origin/${GIT_BRANCH} not found, skipping git reset"
  fi
  popd >/dev/null
else
  warn "No .git directory in $APP_DIR — manual deploys not supported by this script. Please deploy manually."
fi

# --- node deps & build ---
if [ -f "$APP_DIR/package.json" ]; then
  info "Installing Node dependencies (preferring npm ci)..."
  pushd "$APP_DIR" >/dev/null
  if command -v npm >/dev/null 2>&1; then
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
  if cp -f "${VAPID_BAK}" "${VAPID_FILE}"; then
    chmod 600 "${VAPID_FILE}" || true
    ok "VAPID restored"
  else
    warn "Failed to restore VAPID file"
  fi
fi

# --- create/update systemd drop-in from .vapid.json if present ---
RELOAD_SYSTEMD=false
if [ -f "${VAPID_FILE}" ]; then
  # extract keys (try jq, node, then sed)
  VAPID_PUBLIC=""
  VAPID_PRIVATE=""
  if command -v jq >/dev/null 2>&1; then
    VAPID_PUBLIC=$(jq -r '.publicKey // empty' "${VAPID_FILE}" 2>/dev/null || true)
    VAPID_PRIVATE=$(jq -r '.privateKey // empty' "${VAPID_FILE}" 2>/dev/null || true)
  fi
  if [ -z "$VAPID_PUBLIC" ] || [ -z "$VAPID_PRIVATE" ]; then
    if command -v node >/dev/null 2>&1; then
      VAPID_PUBLIC=$(node -e "try{console.log(require(process.argv[1]).publicKey)}catch(e){process.exit(0)}" "${VAPID_FILE}" 2>/dev/null || true)
      VAPID_PRIVATE=$(node -e "try{console.log(require(process.argv[1]).privateKey)}catch(e){process.exit(0)}" "${VAPID_FILE}" 2>/dev/null || true)
    fi
  fi
  if [ -z "$VAPID_PUBLIC" ] || [ -z "$VAPID_PRIVATE" ]; then
    # last resort use sed (fragile but may work)
    VAPID_PUBLIC="$(sed -n 's/.*\"publicKey\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' "${VAPID_FILE}" || true)"
    VAPID_PRIVATE="$(sed -n 's/.*\"privateKey\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p' "${VAPID_FILE}" || true)"
  fi

  if [ -n "${VAPID_PUBLIC}" ] && [ -n "${VAPID_PRIVATE}" ]; then
    mkdir -p "${SYSTEMD_DROPIN_DIR}" || true
    # compute existing content checksum
    OLD_CHECKSUM=""
    if [ -f "${SYSTEMD_VAPID_CONF}" ]; then OLD_CHECKSUM=$(sha256sum "${SYSTEMD_VAPID_CONF}" | awk '{print $1}') || true; fi

    cat > "${SYSTEMD_VAPID_CONF}" <<EOF
[Service]
Environment=VAPID_PUBLIC_KEY=${VAPID_PUBLIC}
Environment=VAPID_PRIVATE_KEY=${VAPID_PRIVATE}
EOF
    chmod 644 "${SYSTEMD_VAPID_CONF}" || true

    NEW_CHECKSUM=$(sha256sum "${SYSTEMD_VAPID_CONF}" | awk '{print $1}') || true
    if [ "${OLD_CHECKSUM}" != "${NEW_CHECKSUM}" ]; then
      RELOAD_SYSTEMD=true
      ok "Wrote/updated systemd drop-in for VAPID"
    else
      info "Systemd drop-in unchanged"
    fi
  else
    warn "Could not parse VAPID keys; skipping systemd drop-in creation"
  fi
fi

if [ -d "${SYSTEMD_DROPIN_DIR}" ] || [ -f "${SYSTEMD_VAPID_CONF}" ]; then
  RELOAD_SYSTEMD=true
fi

if [ "$RELOAD_SYSTEMD" = true ]; then
  info "Reloading systemd daemon to pick up any drop-ins..."
  if systemctl daemon-reload; then ok "systemd daemon reloaded"; else warn "systemctl daemon-reload failed"; fi
fi

# --- start/restart service with retries ---
start_service() {
  attempts=0
  max_attempts=4
  until systemctl start "${SERVICE_NAME}.service"; do
    attempts=$((attempts+1))
    warn "Attempt ${attempts}/${max_attempts} - failed to start service"
    if [ "$attempts" -ge "$max_attempts" ]; then
      warn "Max attempts reached; printing recent journalctl and exiting with warning"
      journalctl -u "${SERVICE_NAME}.service" -n 200 --no-pager || true
      return 1
    fi
    sleep $((attempts * 2))
  done
  # confirm active
  for i in {1..10}; do
    if systemctl is-active --quiet "${SERVICE_NAME}.service"; then
      ok "Service ${SERVICE_NAME}.service is active"
      return 0
    fi
    sleep 1
  done
  warn "Service start requested but not reporting active state yet"
  return 0
}

info "Starting (or restarting) service ${SERVICE_NAME}.service..."
if start_service; then
  ok "Service start sequence completed"
else
  warn "Service start sequence encountered issues - check logs"
fi

# --- show recent logs for convenience ---
info "Recent logs (last 200 lines) for ${SERVICE_NAME}.service:"
journalctl -u "${SERVICE_NAME}.service" -n 200 --no-pager || true

ok "Update completed. Backups: DB=${DB_BAK:-none} uploads=${UP_BAK:-none} code=${CODE_BACKUP:-none} vapid=${VAPID_BAK:-none}"
