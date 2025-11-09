#!/bin/bash
# sTalk Uninstaller Script
# Author: JungleeAadmi
# Safely removes sTalk without deleting the container or system config.

set -e

APP_DIR="/opt/stalk"
SERVICE_NAME="stalk"
DB_PATH="$APP_DIR/database/stalk.db"
UPLOADS_PATH="$APP_DIR/uploads"
SYSTEMD_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "🧹 Uninstalling sTalk..."

# Step 1: Check if app exists
if [ ! -d "$APP_DIR" ]; then
    echo "❌ sTalk is not installed in $APP_DIR."
    exit 1
fi

# Step 2: Confirm
read -p "⚠️  This will remove sTalk files and data (database & uploads). Continue? [y/N]: " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    echo "🛑 Uninstallation cancelled."
    exit 0
fi

# Step 3: Stop service if running
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "🛑 Stopping sTalk service..."
    sudo systemctl stop "$SERVICE_NAME"
fi

# Step 4: Disable service
if systemctl list-unit-files | grep -q "$SERVICE_NAME.service"; then
    echo "🚫 Disabling sTalk service..."
    sudo systemctl disable "$SERVICE_NAME"
fi

# Step 5: Remove files
echo "🗑️  Removing sTalk files..."
sudo rm -rf "$APP_DIR"

# Step 6: Remove systemd service
if [ -f "$SYSTEMD_FILE" ]; then
    echo "🧾 Removing systemd service..."
    sudo rm -f "$SYSTEMD_FILE"
    sudo systemctl daemon-reload
fi

# Step 7: Cleanup npm dependencies cache (optional)
if command -v npm &>/dev/null; then
    echo "🧽 Cleaning npm cache..."
    npm cache clean --force >/dev/null 2>&1 || true
fi

# Step 8: Done
echo "✅ sTalk has been completely removed."
echo "🧰 You can reinstall anytime with:"
echo "   wget -qO- https://raw.githubusercontent.com/JungleeAadmi/sTalk/main/install.sh | sudo bash"
