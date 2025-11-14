#!/usr/bin/env bash
# cleanup-old-backups.sh - delete old sTalk backups
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/root}"
DAYS="${DAYS:-30}"
DRY_RUN="${DRY_RUN:-false}"

echo "Cleanup old sTalk backups in $BACKUP_DIR older than $DAYS days"
echo

# patterns to remove
patterns=( "stalk.db.*.bak" "stalk-uploads-*.tar.gz" "stalk_logs_*.tar.gz" )

for p in "${patterns[@]}"; do
  echo "Checking pattern: $p"
  if [ "$DRY_RUN" = "true" ]; then
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "$p" -mtime +"$DAYS" -print
  else
    find "$BACKUP_DIR" -maxdepth 1 -type f -name "$p" -mtime +"$DAYS" -print -exec rm -f {} \;
  fi
done

echo
if [ "$DRY_RUN" = "true" ]; then
  echo "DRY RUN complete. To actually delete, rerun with DRY_RUN=false (default)."
else
  echo "Cleanup complete."
fi
