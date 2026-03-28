#!/usr/bin/env bash
#
# snapshot.sh — Create, list, and restore snapshots of the Engram vault.
#
# Snapshots capture the engram/ directory inside your vault (memories, soul,
# scratch, conversations, working, archive). The rest of your vault is untouched.
#
# Snapshots are stored in .snapshots/ at the repo root (gitignored, not in iCloud).
# Restoring always creates a safety snapshot of the current state first.
#
# Usage:
#   ./scripts/snapshot.sh create              # snapshot current Engram
#   ./scripts/snapshot.sh list                # list available snapshots
#   ./scripts/snapshot.sh restore             # pick a snapshot to restore (interactive)
#   ./scripts/snapshot.sh restore <filename>  # restore a specific snapshot
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SNAPSHOTS_DIR="$REPO_ROOT/.snapshots"

# ─── Resolve vault path ─────────────────────────────────────────────────────
# Save and clear positional args so resolve-vault.sh doesn't interpret
# the subcommand name as a vault path override.

_saved_args=("$@")
set --
source "$REPO_ROOT/scripts/resolve-vault.sh"
set -- "${_saved_args[@]}"
unset _saved_args

ENGRAM_DIR="$VAULT_PATH/engram"

if [ ! -d "$ENGRAM_DIR" ]; then
  echo "Error: engram/ directory not found at $ENGRAM_DIR"
  echo "       Check ENGRAM_VAULT_PATH in .env"
  exit 1
fi

mkdir -p "$SNAPSHOTS_DIR"

# ─── Subcommands ────────────────────────────────────────────────────────────

cmd="${1:-}"

case "$cmd" in

  # ── create ────────────────────────────────────────────────────────────────

  create)
    TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%S)"
    FILENAME="engram-${TIMESTAMP}.tar.gz"
    DEST="$SNAPSHOTS_DIR/$FILENAME"

    echo "Snapshotting engram/ → $FILENAME"
    tar -czf "$DEST" -C "$VAULT_PATH" engram
    SIZE="$(du -sh "$DEST" | cut -f1)"
    echo "Done. ($SIZE)"
    ;;

  # ── list ──────────────────────────────────────────────────────────────────

  list)
    snapshots=("$SNAPSHOTS_DIR"/engram-*.tar.gz)

    if [ ! -e "${snapshots[0]}" ]; then
      echo "No snapshots found in $SNAPSHOTS_DIR"
      exit 0
    fi

    echo "Snapshots in $SNAPSHOTS_DIR:"
    echo ""
    i=1
    for f in "${snapshots[@]}"; do
      size="$(du -sh "$f" | cut -f1)"
      name="$(basename "$f")"
      printf "  %2d.  %-40s %s\n" "$i" "$name" "$size"
      i=$((i + 1))
    done
    echo ""
    ;;

  # ── restore ───────────────────────────────────────────────────────────────

  restore)
    snapshots=("$SNAPSHOTS_DIR"/engram-*.tar.gz)

    if [ ! -e "${snapshots[0]}" ]; then
      echo "No snapshots found in $SNAPSHOTS_DIR"
      exit 1
    fi

    # If a specific file was given, use it directly
    if [ -n "${2:-}" ]; then
      TARGET="$2"
      # Allow bare filename or full path
      [ -f "$TARGET" ] || TARGET="$SNAPSHOTS_DIR/$2"
      if [ ! -f "$TARGET" ]; then
        echo "Error: snapshot not found: $2"
        exit 1
      fi
    else
      # Interactive selection
      echo "Available snapshots:"
      echo ""
      i=1
      for f in "${snapshots[@]}"; do
        size="$(du -sh "$f" | cut -f1)"
        name="$(basename "$f")"
        printf "  %2d.  %-40s %s\n" "$i" "$name" "$size"
        i=$((i + 1))
      done
      echo ""
      printf "Restore which snapshot? (1-%d): " "${#snapshots[@]}"
      read -r choice

      if ! [[ "$choice" =~ ^[0-9]+$ ]] || [ "$choice" -lt 1 ] || [ "$choice" -gt "${#snapshots[@]}" ]; then
        echo "Invalid selection."
        exit 1
      fi

      TARGET="${snapshots[$((choice - 1))]}"
    fi

    echo ""
    echo "Restoring: $(basename "$TARGET")"
    echo "Target:    $ENGRAM_DIR"
    echo ""
    printf "This will replace the current engram/. Continue? [y/N]: "
    read -r confirm

    if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
      echo "Aborted."
      exit 0
    fi

    # Safety snapshot of current state before overwriting
    SAFETY_TIMESTAMP="$(date -u +%Y-%m-%dT%H%M%S)"
    SAFETY_FILE="$SNAPSHOTS_DIR/engram-${SAFETY_TIMESTAMP}-pre-restore.tar.gz"
    echo ""
    echo "Creating safety snapshot of current state..."
    tar -czf "$SAFETY_FILE" -C "$VAULT_PATH" engram
    echo "Safety snapshot: $(basename "$SAFETY_FILE")"

    # Restore
    echo "Restoring..."
    rm -rf "$ENGRAM_DIR"
    tar -xzf "$TARGET" -C "$VAULT_PATH"
    echo ""
    echo "Restored. Safety snapshot saved as $(basename "$SAFETY_FILE") if you need to undo."
    ;;

  *)
    echo "Usage:"
    echo "  $(basename "$0") create              — snapshot current Engram"
    echo "  $(basename "$0") list                — list available snapshots"
    echo "  $(basename "$0") restore             — pick a snapshot to restore"
    echo "  $(basename "$0") restore <filename>  — restore a specific snapshot"
    exit 1
    ;;

esac
