#!/bin/bash

################################################################################
# sTalk Installation Script
# 
# This script automatically installs sTalk on Debian/Ubuntu-based systems
# Usage: curl -fsSL https://raw.githubusercontent.com/JungleeAadmi/sTalk/main/install.sh | sudo bash
################################################################################

set -e  # Exit on error

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

################################################################################
# Helper Functions
################################################################################

print_header() {
    echo -e "${BLUE}"
    echo "╔═══════════════════════════════════════════════════════════════╗"
    echo "║                                                               ║"
    echo "║                    sTalk Installer v2.0.0                     ║"
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
        NODE_VERSION=$(node -v | cut -d 'v' -f 2 | cut -d '.' -f 1)
        if [ "$NODE_VERSION" -ge 16 ]; then
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
# sTalk Installation
################################################################################

install_stalk() {
    print_step "Installing sTalk..."
    
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
    
    # Install dependencies
    print_step "Installing dependencies (this may take a few minutes)..."
    npm install --production --silent
    print_success "Dependencies installed"
    
    # Create necessary directories
    mkdir -p database uploads/files uploads/images uploads/audio uploads/documents uploads/profiles
    print_success "Directory structure created"
    
    # Set permissions
    chmod -R 755 "$STALK_DIR"
    print_success "Permissions set"
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
    
    # Reload systemd
    systemctl daemon-reload
    print_success "Service file created"
    
    # Enable service
    systemctl enable ${SERVICE_NAME}
    print_success "Service enabled for auto-start"
    
    # Start service
    systemctl start ${SERVICE_NAME}
    print_success "Service started"
    
    # Wait a moment for service to start
    sleep 2
    
    # Check service status
    if systemctl is-active --quiet ${SERVICE_NAME}; then
        print_success "sTalk is running"
    else
        print_error "Service failed to start. Check logs with: journalctl -u ${SERVICE_NAME} -f"
        exit 1
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
# Post-Installation
################################################################################

print_completion() {
    SERVER_IP=$(hostname -I | awk '{print $1}')
    
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
    setup_service
    configure_firewall
    
    echo ""
    print_completion
}

# Run main installation
main
