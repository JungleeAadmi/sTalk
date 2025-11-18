#!/usr/bin/env bash
################################################################################
# sTalk Installation Script (v3.1)
#
# Full automated installer:
# - Detect OS, require root & internet
# - Install Node.js 20.x and Git
# - Clone/upgrade sTalk into /opt/sTalk
# - Install npm dependencies (production)
# - Generate VAPID keys (web-push) and store in .vapid.json
# - Create systemd drop-in with VAPID env vars
# - Create systemd service, enable & start
# - Create directories (uploads, profiles, database)
# - Attempt to fetch server /api/push/key and print public key
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/JungleeAadmi/sTalk/main/install.sh | sudo bash
################################################################################

set -euo pipefail

# -------------------------
# Configurable values
# -------------------------
STALK_DIR="${STALK_DIR:-/opt/sTalk}"
SERVICE_NAME="${SERVICE_NAME:-stalk}"
PORT="${PORT:-3000}"
VAPID_FILE="${STALK_DIR}/.vapid.json"
SYSTEMD_DROPIN_DIR="/etc/systemd/system/${SERVICE_NAME}.service.d"
SYSTEMD_VAPID_CONF="${SYSTEMD_DROPIN_DIR}/vapid.conf"
BACKUP_VAPID_TMP="/tmp/stalk_vapid_backup.json"
REPO_URL="https://github.com/JungleeAadmi/sTalk.git"
NODE_SETUP_URL="https://deb.nodesource.com/setup_20.x"

# -------------------------
# Colors / logging helpers
# -------------------------
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'; NC='\033[0m'
step(){ printf "${BLUE}▶ %s${NC}\n" "$*"; }
info(){ printf "${YELLOW}ℹ %s${NC}\n" "$*"; }
ok(){ printf "${GREEN}✓ %s${NC}\n" "$*"; }
err(){ printf "${RED}✗ %s${NC}\n" "$*"; }

# -------------------------
# Pre-checks
# -------------------------
require_root() {
  if [ "${EUID:-$(id -u)}" -ne 0 ]; then
    err "This installer must be run as root (use sudo)."
    exit 1
  fi
  ok "Running as root."
}

require_internet() {
  step "Checking internet connectivity..."
  if ping -c1 -W2 8.8.8.8 >/dev/null 2>&1 || ping -c1 -W2 google.com >/dev/null 2>&1; then
    ok "Internet reachable"
  else
    err "No internet connectivity detected. Aborting."
    exit 1
  fi
}

detect_os() {
  step "Detecting operating system..."
  if [ -f /etc/os-release ]; then
    . /etc/os-release
    ok "Detected: ${PRETTY_NAME:-$NAME}"
  else
    info "Could not read /etc/os-release — proceeding but installer was designed for Debian/Ubuntu."
  fi
}

# -------------------------
# Installer helpers
# -------------------------
install_nodejs() {
  step "Checking Node.js..."
  if command -v node >/dev/null 2>&1; then
    NODE_MAJOR=$(node -v | cut -dv -f2 | cut -d. -f1)
    if [ "${NODE_MAJOR:-0}" -ge 16 ]; then
      ok "Node.js $(node -v) present"
      return
    else
      info "Found Node.js $(node -v) — upgrading to 20.x"
    fi
  fi

  step "Installing Node.js 20.x LTS..."
  apt-get update -qq
  apt-get install -y -qq curl gnupg2 ca-certificates lsb-release apt-transport-https || apt-get install -y curl gnupg2 ca-certificates lsb-release apt-transport-https
  curl -fsSL "${NODE_SETUP_URL}" | bash -
  apt-get install -y -qq nodejs || apt-get install -y nodejs
  if command -v node >/dev/null 2>&1; then
      ok "Node installed: $(node -v)"
  else
      err "Node installation failed."
      exit 1
  fi
}

install_git() {
  step "Checking Git..."
  if command -v git >/dev/null 2>&1; then
    ok "Git present"
    return
  fi
  step "Installing Git..."
  apt-get install -y -qq git || apt-get install -y git
  ok "Git installed"
}

ensure_npm_tools() {
  step "Ensuring web-push helper is available (used to generate VAPID keys)..."
  # Don't modify package.json permanently; install to node_modules if missing so npx works reliably
  if ! npx --yes web-push --version >/dev/null 2>&1; then
    # attempt local install (non-fatal)
    if [ -d "${STALK_DIR}" ] && [ -f "${STALK_DIR}/package.json" ]; then
      ( cd "${STALK_DIR}" && npm install --no-save --silent web-push ) || true
    else
      npm install --no-save --silent web-push || true
    fi
  fi
  ok "web-push helper ensured (npx will be available)"
}

# -------------------------
# Clone/app install
# -------------------------
install_stalk() {
  step "Installing sTalk into ${STALK_DIR}..."

  # Backup preexisting VAPID
  if [ -f "${VAPID_FILE}" ]; then
    info "Existing VAPID found — backing up to ${BACKUP_VAPID_TMP}"
    cp -f "${VAPID_FILE}" "${BACKUP_VAPID_TMP}" 2>/dev/null || true
  fi

  # Stop service, remove old dir (preserve uploads/database via repo layout)
  systemctl stop "${SERVICE_NAME}" 2>/dev/null || true
  rm -rf "${STALK_DIR}"

  # Clone repo
  step "Cloning repository..."
  git clone --depth=1 "${REPO_URL}" "${STALK_DIR}" || { err "Failed to clone ${REPO_URL}"; exit 1; }
  ok "Repository cloned"

  cd "${STALK_DIR}"

  step "Installing production dependencies (npm)..."
  if command -v npm >/dev/null 2>&1; then
    npm ci --production --prefer-offline --no-audit --silent || npm install --production --silent || true
  else
    err "npm not found after Node install"
    exit 1
  fi
  ok "Dependencies installed (or attempted)"

  # Restore VAPID backup if present (move into place)
  if [ -f "${BACKUP_VAPID_TMP}" ] && [ ! -f "${VAPID_FILE}" ]; then
    mv -f "${BACKUP_VAPID_TMP}" "${VAPID_FILE}" || true
    chmod 600 "${VAPID_FILE}" 2>/dev/null || true
    ok "Restored previous VAPID keys"
  fi

  # Create directories used by app (uploads etc.)
  mkdir -p "${STALK_DIR}/database" "${STALK_DIR}/uploads/files" "${STALK_DIR}/uploads/images" "${STALK_DIR}/uploads/audio" "${STALK_DIR}/uploads/documents" "${STALK_DIR}/uploads/profiles"
  chmod -R 755 "${STALK_DIR}"
  [ -f "${VAPID_FILE}" ] && chmod 600 "${VAPID_FILE}" || true
  ok "Directory structure ensured and permissions set"
}

# -------------------------
# VAPID generation / extraction
# -------------------------
generate_vapid_and_dropin() {
  step "Configuring VAPID keys and systemd drop-in..."

  SUBJECT="${INSTALL_VAPID_SUBJECT:-mailto:admin@$(hostname -f 2>/dev/null || hostname)}"

  # Generate keys if missing
  if [ -f "${VAPID_FILE}" ]; then
    info "VAPID file already exists at ${VAPID_FILE}"
  else
    info "Generating VAPID keys (web-push npx)..."
    # Ensure npx & web-push available
    ensure_npm_tools
    # Try to generate into file
    if npx --yes web-push generate-vapid-keys --json > "${VAPID_FILE}" 2>/dev/null; then
      chmod 600 "${VAPID_FILE}" 2>/dev/null || true
      ok "VAPID keys generated and saved to ${VAPID_FILE}"
    else
      err "Failed to generate VAPID keys via npx web-push"
      return 1
    fi
  fi

  # Extract keys (prefer jq, else Node)
  VAPID_PUBLIC=""
  VAPID_PRIVATE=""
  if command -v jq >/dev/null 2>&1; then
    VAPID_PUBLIC="$(jq -r '.publicKey' "${VAPID_FILE}" 2>/dev/null || true)"
    VAPID_PRIVATE="$(jq -r '.privateKey' "${VAPID_FILE}" 2>/dev/null || true)"
  fi

  if [ -z "${VAPID_PUBLIC}" ] || [ "${VAPID_PUBLIC}" = "null" ]; then
    if command -v node >/dev/null 2>&1; then
      VAPID_PUBLIC="$(node -e "try{console.log(require('${VAPID_FILE}').publicKey)}catch(e){process.exit(0)}" 2>/dev/null || true)"
      VAPID_PRIVATE="$(node -e "try{console.log(require('${VAPID_FILE}').privateKey)}catch(e){process.exit(0)}" 2>/dev/null || true)"
    fi
  fi

  if [ -z "${VAPID_PUBLIC}" ] || [ -z "${VAPID_PRIVATE}" ]; then
    err "Unable to extract VAPID keys from ${VAPID_FILE} (jq/node fallback failed)."
    return 1
  fi

  # Write systemd drop-in to expose env vars to service
  mkdir -p "${SYSTEMD_DROPIN_DIR}"
  cat > "${SYSTEMD_VAPID_CONF}" <<EOF
[Service]
Environment=VAPID_PUBLIC_KEY="${VAPID_PUBLIC}"
Environment=VAPID_PRIVATE_KEY="${VAPID_PRIVATE}"
Environment=VAPID_SUBJECT="${SUBJECT}"
EOF
  chmod 644 "${SYSTEMD_VAPID_CONF}"
  ok "Wrote systemd drop-in: ${SYSTEMD_VAPID_CONF}"

  systemctl daemon-reload || true
}

# -------------------------
# Systemd service unit
# -------------------------
setup_systemd_service() {
  step "Installing systemd service unit..."

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=sTalk - Team Communication Platform
Documentation=https://github.com/JungleeAadmi/sTalk
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${STALK_DIR}
ExecStart=/usr/bin/node ${STALK_DIR}/server.js
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=stalk

# Environment (NODE_ENV and PORT are kept here; VAPID vars come from drop-in)
Environment=NODE_ENV=production
Environment=PORT=${PORT}

# Security
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" || true

  # Start or restart service
  if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    info "Service already running — restarting to pick up changes"
    systemctl restart "${SERVICE_NAME}" || true
  else
    systemctl start "${SERVICE_NAME}" || true
  fi

  sleep 2
  if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    ok "Systemd service ${SERVICE_NAME} is active"
  else
    err "Service failed to start; check: journalctl -u ${SERVICE_NAME} -f"
  fi
}

# -------------------------
# Firewall (UFW) helper
# -------------------------
configure_firewall() {
  if command -v ufw >/dev/null 2>&1; then
    if ufw status | grep -qi "active"; then
      step "Adding UFW rule for port ${PORT}"
      ufw allow "${PORT}/tcp" >/dev/null 2>&1 || true
      ok "UFW rule added for ${PORT}"
    else
      info "UFW installed but not active"
    fi
  else
    info "UFW not present — skipping firewall configuration"
  fi
}

# -------------------------
# Wait for server and fetch public key
# -------------------------
wait_for_server_and_show_key() {
  step "Waiting for sTalk HTTP server and fetching /api/push/key..."
  tries=12
  wait_seconds=2
  i=0
  while [ $i -lt $tries ]; do
    if curl -sS "http://localhost:${PORT}/api/push/key" -m 3 -o /tmp/stalk_push_key.json 2>/dev/null; then
      if grep -q '"publicKey"' /tmp/stalk_push_key.json 2>/dev/null; then
        PUB="$(jq -r '.publicKey' /tmp/stalk_push_key.json 2>/dev/null || sed -n 's/.*"publicKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /tmp/stalk_push_key.json || true)"
        if [ -n "${PUB}" ]; then
          ok "Public VAPID key available from server:"
          printf "%s\n" "${PUB}"
          return 0
        fi
      fi
    fi
    i=$((i+1))
    sleep "${wait_seconds}"
  done

  info "Could not fetch /api/push/key (server may still be starting). You can retrieve it later:"
  echo "  curl http://localhost:${PORT}/api/push/key"
}

# -------------------------
# Summary + completion
# -------------------------
final_message() {
  IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo "localhost")"
  echo
  ok "sTalk installation completed (attempted)."
  echo
  echo "Access:"
  echo "  http://localhost:${PORT}"
  echo "  http://${IP}:${PORT}"
  echo
  echo "Default admin credentials: admin / admin"
  echo
  echo "To view service logs: sudo journalctl -u ${SERVICE_NAME} -f"
  echo
}

# -------------------------
# Main flow
# -------------------------
main() {
  require_root
  require_internet
  detect_os

  install_nodejs
  install_git

  install_stalk

  # generate VAPID keys and configure systemd drop-in
  generate_vapid_and_dropin

  # setup service unit and start service
  setup_systemd_service

  # firewall
  configure_firewall

  # show public key
  wait_for_server_and_show_key

  final_message
}

main "$@"
