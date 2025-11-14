#!/usr/bin/env bash
# sTalk update-check script
# Does NOT:
#  - stop service
#  - pull from git
#  - overwrite files
#  - restart service
# Instead:
#  - scans repo status
#  - checks remote differences
#  - simulates dependency install
#  - prints what real update would do

set -euo pipefail

info(){ printf "\033[1;34mℹ️  %s\033[0m\n" "$*"; }
ok(){   printf "\033[1;32m✅ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m⚠️  %s\033[0m\n" "$*"; }
err(){  printf "\033[1;31m❌ %s\033[0m\n" "$*"; exit 1; }

DEFAULT_CANDIDATES=( "/opt/stalk" "/opt/sTalk" "/opt/sTalk-*" "/opt/sTalk-v2" )
APP_DIR="${APP_DIR:-}"

info "Detecting sTalk installation..."

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
  err "Could not detect installation. Set APP_DIR manually."
fi

APP_DIR="$(readlink -f "$APP_DIR")"
info "Using APP_DIR = $APP_DIR"

if [ ! -d "$APP_DIR/.git" ]; then
  err "No .git directory — update-check cannot continue."
fi

pushd "$APP_DIR" >/dev/null

info "Checking local repo cleanliness..."
if ! git diff --quiet || ! git diff --cached --quiet; then
  warn "Local changes detected — update may overwrite them."
else
  ok "Working tree clean"
fi

info "Fetching remote info..."
git fetch --all --prune

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u} || echo "")

if [ -z "$REMOTE" ]; then
  warn "No upstream branch detected."
else
  info "Comparing local vs remote..."
  if [ "$LOCAL" = "$REMOTE" ]; then
    ok "Local installation is up-to-date"
  else
    warn "Updates available!"
    git log --oneline "$LOCAL..$REMOTE"
  fi
fi

info "Simulating dependency check..."
if [ -f package.json ]; then
  if command -v npm >/dev/null 2>&1; then
    npm ls --production >/dev/null 2>&1 && ok "Dependencies appear consistent" || warn "Dependency issues detected"
  else
    warn "npm missing — cannot check dependencies"
  fi
fi

info "Checking build script..."
if grep -q "\"build\"" package.json >/dev/null 2>&1; then
  ok "Build script exists (npm run build)"
else
  warn "No build script present"
fi

popd >/dev/null

ok "Dry-run update check complete. No changes were made."
