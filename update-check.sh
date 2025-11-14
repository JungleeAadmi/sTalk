#!/usr/bin/env bash
# sTalk update-check script (improved)
# Purpose: perform a dry-run inspection that reports what an update would do.
# - Does NOT stop services, pull, overwrite, or restart anything.
# - Fetches remote refs, compares local vs remote, checks working tree,
#   simulates dependency install (best-effort), and reports build script presence.
#
# Usage:
#   sudo bash update-check.sh
# or
#   APP_DIR=/opt/sTalk bash update-check.sh

set -euo pipefail

# --- helpers ---
info(){ printf "\033[1;34mℹ️  %s\033[0m\n" "$*"; }
ok(){   printf "\033[1;32m✅ %s\033[0m\n" "$*"; }
warn(){ printf "\033[1;33m⚠️  %s\033[0m\n" "$*"; }
err(){  printf "\033[1;31m❌ %s\033[0m\n" "$*"; exit 1; }

# --- detect app dir ---
DEFAULT_CANDIDATES=( "/opt/stalk" "/opt/sTalk" "/opt/sTalk-*" "/opt/sTalk-v2" )
APP_DIR="${APP_DIR:-}"

info "Detecting sTalk installation..."

if [ -z "$APP_DIR" ]; then
  for cand in "${DEFAULT_CANDIDATES[@]}"; do
    # expand glob safely
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

[ -z "${APP_DIR:-}" ] && err "Could not detect installation. Set APP_DIR=/path/to/sTalk and re-run."
APP_DIR="$(readlink -f "$APP_DIR")"
info "Using APP_DIR = $APP_DIR"

# --- repo checks ---
if [ ! -d "$APP_DIR/.git" ]; then
  err "No .git directory found in ${APP_DIR} — update-check cannot continue."
fi

pushd "$APP_DIR" >/dev/null

# check current branch
CUR_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "HEAD")
info "Current git branch: ${CUR_BRANCH}"

info "Checking working tree status..."
# git status porcelain gives useful machine-readable output
STATUS="$(git status --porcelain 2>/dev/null || true)"
if [ -n "$STATUS" ]; then
  warn "Local working tree is not clean. Uncommitted/untracked changes detected:"
  git status --short
else
  ok "Working tree clean"
fi

# also show untracked files separately (if any)
UNTRACKED=$(git ls-files --others --exclude-standard 2>/dev/null || true)
if [ -n "$UNTRACKED" ]; then
  warn "Untracked files present (these won't be overwritten by a git pull unless you force):"
  printf "%s\n" "$UNTRACKED"
fi

info "Fetching remote refs (dry)..."
# fetch only remote metadata, keep --prune for accuracy
if git fetch --all --prune --quiet 2>/dev/null; then
  ok "Fetched remote refs"
else
  warn "git fetch failed (network or remote). Continuing with local info."
fi

# determine upstream for current branch (if any)
UPSTREAM=""
if git rev-parse --abbrev-ref --symbolic-full-name "@{u}" >/dev/null 2>&1; then
  UPSTREAM="@{u}"
else
  # attempt to find an upstream from 'origin' for current branch
  if git for-each-ref --format='%(upstream:short)' refs/heads/"$CUR_BRANCH" | grep -q .; then
    UPSTREAM="$(git for-each-ref --format='%(upstream:short)' refs/heads/"$CUR_BRANCH")"
  fi
fi

if [ -z "$UPSTREAM" ]; then
  warn "No upstream branch configured for ${CUR_BRANCH}. Cannot compare local vs remote automatically."
else
  info "Comparing local HEAD vs ${UPSTREAM}..."
  # ensure refs exist
  if git rev-parse --verify "$UPSTREAM" >/dev/null 2>&1; then
    LOCAL_SHA=$(git rev-parse --verify HEAD)
    REMOTE_SHA=$(git rev-parse --verify "$UPSTREAM")
    if [ "$LOCAL_SHA" = "$REMOTE_SHA" ]; then
      ok "Local is up-to-date with ${UPSTREAM}"
    else
      warn "Local differs from ${UPSTREAM}. Changes that would be pulled (new commits on remote):"
      git --no-pager log --oneline "${LOCAL_SHA}..${REMOTE_SHA}" || true
      echo
      warn "Commits that exist locally but not on remote (if any):"
      git --no-pager log --oneline "${REMOTE_SHA}..${LOCAL_SHA}" || true
    fi
  else
    warn "Upstream ref ${UPSTREAM} not resolvable. Remote branch may not exist yet."
  fi
fi

# show any protected files that would be replaced by a hard reset/pull
info "Files that would be overwritten by a hard reset (if local changes exist):"
git ls-files -m || true

# --- dependency simulation ---
info "Simulating dependency installation (best-effort)..."
if [ -f package.json ]; then
  if command -v npm >/dev/null 2>&1; then
    # prefer npm ci --dry-run where available
    if npm help ci >/dev/null 2>&1; then
      info "Running: npm ci --dry-run --silent"
      if npm ci --dry-run --silent >/dev/null 2>&1; then
        ok "npm ci dry-run succeeded (dependencies appear consistent)"
      else
        warn "npm ci dry-run reported issues (inspect manually)"
      fi
    else
      # fallback: npm install --dry-run
      info "Running: npm install --dry-run --silent"
      if npm install --dry-run --silent >/dev/null 2>&1; then
        ok "npm install dry-run completed"
      else
        warn "npm install dry-run reported issues (inspect manually)"
      fi
    fi
  else
    warn "npm not installed on this host — cannot simulate dependency install"
  fi
else
  info "No package.json found — probably no Node dependencies to check"
fi

# --- build script check ---
info "Checking for build script in package.json..."
HAS_BUILD=false
if [ -f package.json ]; then
  # prefer node-based parse if node available for correct JSON handling
  if command -v node >/dev/null 2>&1; then
    if node -e "const p=require('./package.json'); console.log(!!(p.scripts && p.scripts.build));" 2>/dev/null | grep -q true; then
      HAS_BUILD=true
    fi
  else
    # fallback to a safe grep
    if grep -q '"build"\s*:' package.json >/dev/null 2>&1; then
      HAS_BUILD=true
    fi
  fi
fi

if [ "$HAS_BUILD" = true ]; then
  ok "Build script present (npm run build). An update may trigger a build step."
else
  info "No build script detected"
fi

# --- summary & recommendations ---
echo
info "Summary / recommendations:"
[ -n "$STATUS" ] && warn "Working tree is dirty — commit or stash changes before updating."
[ -n "$UNTRACKED" ] && warn "Untracked files exist — keep backups if important."
if [ -z "$UPSTREAM" ]; then
  warn "No upstream configured — consider configuring a remote branch (e.g. origin/main) to enable automated updates."
fi
if [ "$HAS_BUILD" = true ]; then
  info "After update, the installer will likely run 'npm ci' and 'npm run build'. Ensure your system has Node & npm."
fi

ok "Dry-run update check complete — no files changed by this script."

popd >/dev/null
