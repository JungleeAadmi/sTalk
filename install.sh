#!/bin/bash

################################################################################
# sTalk Installation Script (updated v3.0)
#
# This script automatically installs sTalk on Debian/Ubuntu-based systems
# Usage: curl -fsSL https://raw.githubusercontent.com/JungleeAadmi/sTalk/main/install.sh | sudo bash
################################################################################

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Installation settings
STALK_DIR="/opt/sTalk"
SERVICE_NAME="stalk"
PORT=3000
VAPID_FILE="${STALK_DIR}/.vapid.json"
SYSTEMD_DROPIN_DIR="/etc/systemd/system/${SERVICE_NAME}.service.d"
SYSTEMD_VAPID_CONF="${SYSTEMD_DROPIN_DIR}/vapid.conf"

################################################################################
# Helper Functions
################################################################################

print_header() {
    echo -e "${BLUE}"
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║                                                               ║"
    echo "║                    sTalk Installer v3.0.0                     ║"
    echo "║          Mobile-first Team Communication Platform            ║"
    echo "║                                                               ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}ℹ $1${NC}"
}

print_step() {
    echo -e "${BLUE}▶ $1${NC}"
}

################################################################################
# System Detection
################################################################################

detect_os() {
    print_step "Detecting operating system..."
    
    if [ -f /etc/os-release ]; then
        . /etc/os-release
        OS=$ID
        OS_VERSION=$VERSION_ID
        print_success "Detected: $PRETTY_NAME"
    else
        print_error "Cannot detect operating system"
        exit 1
    fi
    
    # Check if OS is supported
    case "$OS" in
        ubuntu|debian|raspbian)
            print_success "Supported OS detected"
            ;;
        *)
            print_info "Warning: Untested OS. Installation may fail."
            read -p "Continue anyway? (y/N) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                exit 1
            fi
            ;;
    esac
}

################################################################################
# Prerequisite Checks
################################################################################

check_root() {
    if [ "$EUID" -ne 0 ]; then
        print_error "This script must be run as root (use sudo)"
        exit 1
    fi
    print_success "Running with root privileges"
}

check_internet() {
    print_step "Checking internet connectivity..."
    if ping -c 1 google.com &> /dev/null; then
        print_success "Internet connection available"
    else
        print_error "No internet connection detected"
        exit 1
    fi
}

################################################################################
# Node.js Installation
################################################################################

install_nodejs() {
    print_step "Checking Node.js installation..."
    
    if command -v node &> /dev/null; then
        NODE_MAJOR=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
        if [ "$NODE_MAJOR" -ge 16 ]; then
            print_success "Node.js $(node -v) already installed"
            return
        else
            print_info "Node.js version is too old ($(node -v)). Upgrading..."
        fi
    fi
    
    print_step "Installing Node.js 20.x LTS..."
    
    # Install prerequisites
    apt-get update -qq
    apt-get install -y -qq curl gnupg2 ca-certificates lsb-release apt-transport-https
    
    # Add NodeSource repository
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    
    # Install Node.js
    apt-get install -y -qq nodejs
    
    if command -v node &> /dev/null; then
        print_success "Node.js $(node -v) installed successfully"
        print_success "npm $(npm -v) installed successfully"
    else
        print_error "Node.js installation failed"
        exit 1
    fi
}

################################################################################
# Git Installation
################################################################################

install_git() {
    print_step "Checking Git installation..."
    
    if command -v git &> /dev/null; then
        print_success "Git already installed"
    else
        print_step "Installing Git..."
        apt-get install -y -qq git
        print_success "Git installed successfully"
    fi
}

################################################################################
# sTalk Installation (clone + deps)
################################################################################

install_stalk() {
    print_step "Installing sTalk..."
    
    # If existing install and it has VAPID, back it up before removing
    BACKUP_VAPID="/tmp/stalk_vapid_backup.json"
    if [ -d "$STALK_DIR" ] && [ -f "${STALK_DIR}/.vapid.json" ]; then
        print_info "Found existing VAPID keys, backing up..."
        cp -f "${STALK_DIR}/.vapid.json" "${BACKUP_VAPID}"
    fi

    # Remove old installation if exists
    if [ -d "$STALK_DIR" ]; then
        print_info "Removing previous installation..."
        systemctl stop $SERVICE_NAME &> /dev/null || true
        systemctl disable $SERVICE_NAME &> /dev/null || true
        rm -rf "$STALK_DIR"
    fi
    
    # Clone repository
    print_step "Cloning sTalk repository..."
    git clone -q https://github.com/JungleeAadmi/sTalk.git "$STALK_DIR"
    cd "$STALK_DIR"
    print_success "Repository cloned"
    
    # Restore VAPID backup if present
    if [ -f "${BACKUP_VAPID}" ]; then
        print_info "Restoring previous VAPID keys..."
        mv -f "${BACKUP_VAPID}" "${VAPID_FILE}"
        chmod 600 "${VAPID_FILE}"
        print_success "VAPID restored"
    fi

    # Install dependencies (production)
    print_step "Installing dependencies (this may take a few minutes)..."
    npm install --production --silent
    print_success "Dependencies installed"
    
    # Ensure web-push is available for npx usage (npx will auto-download but install ensures cache)
    # install web-push locally (non-fatal)
    print_step "Ensuring web-push helper available..."
    npm install --no-save --silent web-push || true
    
    # Create necessary directories
    mkdir -p database uploads/files uploads/images uploads/audio uploads/documents uploads/profiles
    print_success "Directory structure created"
    
    # Set permissions
    chmod -R 755 "$STALK_DIR"
    # but keep VAPID file more restricted
    [ -f "${VAPID_FILE}" ] && chmod 600 "${VAPID_FILE}"
    print_success "Permissions set"
}

################################################################################
# VAPID Keys Generation & systemd drop-in
################################################################################

generate_vapid_and_configure_systemd() {
    # Allow override of subject by environment variable INSTALL_VAPID_SUBJECT,
    # otherwise default to admin@<hostname>
    SUBJECT="${INSTALL_VAPID_SUBJECT:-mailto:admin@$(hostname -f 2>/dev/null || hostname)}"

    # If .vapid.json already exists, don't regenerate
    if [ -f "${VAPID_FILE}" ]; then
        print_success "VAPID keys already present at ${VAPID_FILE} — leaving intact"
    else
        print_step "Generating VAPID keys for this instance..."
        # Use npx to generate vapid keys and save to file
        # the output is a JSON object: {"publicKey":"...","privateKey":"..."}
        if command -v npx &> /dev/null; then
            npx --yes web-push generate-vapid-keys --json > "${VAPID_FILE}"
        else
            # try local ./node_modules/.bin
            if [ -f "./node_modules/.bin/web-push" ]; then
                ./node_modules/.bin/web-push generate-vapid-keys --json > "${VAPID_FILE}"
            else
                # fallback: install temporarily then run
                npm install --no-save --silent web-push
                npx --yes web-push generate-vapid-keys --json > "${VAPID_FILE}"
            fi
        fi

        if [ -f "${VAPID_FILE}" ]; then
            chmod 600 "${VAPID_FILE}"
            print_success "Generated VAPID keys and saved to ${VAPID_FILE}"
        else
            print_error "Failed to generate VAPID keys"
            return 1
        fi
    fi

    # Extract keys (safe parsing)
    VAPID_PUBLIC=$(jq -r '.publicKey' "${VAPID_FILE}" 2>/dev/null || true)
    VAPID_PRIVATE=$(jq -r '.privateKey' "${VAPID_FILE}" 2>/dev/null || true)

    # If jq not present, try node to parse
    if [ -z "$VAPID_PUBLIC" ] || [ -z "$VAPID_PRIVATE" ] || [ "$VAPID_PUBLIC" = "null" ]; then
        if command -v node &> /dev/null; then
            VAPID_PUBLIC=$(node -e "console.log(require('${VAPID_FILE}').publicKey)" 2>/dev/null || true)
            VAPID_PRIVATE=$(node -e "console.log(require('${VAPID_FILE}').privateKey)" 2>/dev/null || true)
        fi
    fi

    if [ -z "$VAPID_PUBLIC" ] || [ -z "$VAPID_PRIVATE" ]; then
        print_error "Could not extract VAPID keys from ${VAPID_FILE}. Ensure file contains valid JSON."
        return 1
    fi

    # Create systemd drop-in dir if not exists
    mkdir -p "${SYSTEMD_DROPIN_DIR}"

    # Write environment drop-in (quotes used for safety)
    cat > "${SYSTEMD_VAPID_CONF}" <<EOF
[Service]
Environment=VAPID_PUBLIC_KEY="${VAPID_PUBLIC}"
Environment=VAPID_PRIVATE_KEY="${VAPID_PRIVATE}"
Environment=VAPID_SUBJECT="${SUBJECT}"
EOF

    chmod 644 "${SYSTEMD_VAPID_CONF}"
    print_success "Wrote systemd drop-in with VAPID environment variables to ${SYSTEMD_VAPID_CONF}"

    # Reload systemd so it picks up the drop-in
    systemctl daemon-reload || true
}

################################################################################
# Systemd Service Setup
################################################################################

setup_service() {
    print_step "Setting up systemd service..."
    
    cat > /etc/systemd/system/${SERVICE_NAME}.service << EOF
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

# Environment variables
Environment=NODE_ENV=production
Environment=PORT=${PORT}

# Security settings
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
    
    # Reload systemd and enable/start
    systemctl daemon-reload
    print_success "Service file created"
    
    systemctl enable ${SERVICE_NAME} || true
    print_success "Service enabled for auto-start"
    
    # Start or restart service
    if systemctl is-active --quiet ${SERVICE_NAME}; then
        print_info "Service already running — restarting to pick up changes"
        systemctl restart ${SERVICE_NAME}
    else
        systemctl start ${SERVICE_NAME}
    fi
    print_success "Service start/restart requested"

    # wait a few seconds for service to settle
    sleep 2
    if systemctl is-active --quiet ${SERVICE_NAME}; then
        print_success "sTalk service is active"
    else
        print_error "Service failed to start. Check logs with: journalctl -u ${SERVICE_NAME} -f"
        # not exiting here because VAPID may still be configured; allow user to inspect
    fi
}

################################################################################
# Firewall Configuration
################################################################################

configure_firewall() {
    print_step "Checking firewall configuration..."
    
    if command -v ufw &> /dev/null; then
        if ufw status | grep -q "Status: active"; then
            print_step "Configuring UFW firewall..."
            ufw allow ${PORT}/tcp &> /dev/null
            print_success "Firewall rule added for port ${PORT}"
        else
            print_info "UFW is installed but not active"
        fi
    else
        print_info "UFW firewall not detected, skipping firewall configuration"
    fi
}

################################################################################
# Post-Installation & quick verification
################################################################################

wait_for_server_and_show_public_key() {
    print_step "Waiting for sTalk HTTP server to respond and fetch public key..."
    # try curl to /api/push/key up to 12 times (approx 30 sec)
    tries=12
    i=0
    while [ $i -lt $tries ]; do
        if curl -sS "http://localhost:${PORT}/api/push/key" -m 3 -o /tmp/stalk_push_key.json 2>/dev/null; then
            if grep -q '"publicKey"' /tmp/stalk_push_key.json 2>/dev/null; then
                PUBLIC=$(jq -r '.publicKey' /tmp/stalk_push_key.json 2>/dev/null || sed -n 's/.*"publicKey"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /tmp/stalk_push_key.json || true)
                if [ -n "$PUBLIC" ]; then
                    print_success "Server push publicKey available:"
                    echo -e "${GREEN}${PUBLIC}${NC}"
                else
                    print_info "Server responded but publicKey missing."
                fi
                return 0
            fi
        fi
        i=$((i+1))
        sleep 2
    done
    print_info "Could not fetch /api/push/key. Server may still be starting or route may differ. You can query it later with:"
    echo "  curl http://localhost:${PORT}/api/push/key"
}

print_completion() {
    SERVER_IP=$(hostname -I | awk '{print $1}' || echo "localhost")
    
    echo ""
    echo -e "${GREEN}"
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║                                                               ║"
    echo "║            🎉 sTalk Installed Successfully! 🎉                ║"
    echo "║                                                               ║"
    echo "╚═══════════════════════════════════════════════════════════════╝"
    echo -e "${NC}"
    echo ""
    echo -e "${BLUE}📱 Access sTalk at:${NC}"
    echo -e "   ${GREEN}http://localhost:${PORT}${NC}"
    echo -e "   ${GREEN}http://${SERVER_IP}:${PORT}${NC}"
    echo ""
    echo -e "${BLUE}🔑 Default Admin Credentials:${NC}"
    echo -e "   Username: ${YELLOW}admin${NC}"
    echo -e "   Password: ${YELLOW}admin${NC}"
    echo ""
    echo -e "${RED}⚠️  IMPORTANT: Change the admin password immediately after login!${NC}"
    echo ""
    echo -e "${BLUE}📚 Useful Commands:${NC}"
    echo -e "   Status:  ${YELLOW}sudo systemctl status ${SERVICE_NAME}${NC}"
    echo -e "   Stop:    ${YELLOW}sudo systemctl stop ${SERVICE_NAME}${NC}"
    echo -e "   Start:   ${YELLOW}sudo systemctl start ${SERVICE_NAME}${NC}"
    echo -e "   Restart: ${YELLOW}sudo systemctl restart ${SERVICE_NAME}${NC}"
    echo -e "   Logs:    ${YELLOW}sudo journalctl -u ${SERVICE_NAME} -f${NC}"
    echo ""
    echo -e "${BLUE}📁 Installation Directory:${NC} ${YELLOW}${STALK_DIR}${NC}"
    echo ""
    echo -e "${BLUE}📖 Documentation:${NC} ${YELLOW}https://github.com/JungleeAadmi/sTalk${NC}"
    echo ""
    echo -e "${GREEN}Thank you for installing sTalk!${NC}"
    echo ""
}

################################################################################
# Main Installation Flow
################################################################################

main() {
    print_header
    
    check_root
    check_internet
    detect_os
    
    echo ""
    print_step "Starting installation process..."
    echo ""
    
    install_nodejs
    install_git
    install_stalk
    generate_vapid_and_configure_systemd
    setup_service
    configure_firewall
    
    # give service a moment, then attempt to fetch public key
    sleep 2
    wait_for_server_and_show_public_key
    
    echo ""
    print_completion
}

# Run main installation
main
