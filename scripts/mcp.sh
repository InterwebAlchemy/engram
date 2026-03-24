#!/usr/bin/env bash
#
# mcp.sh — Launch the Engram MCP server against the dev vault.
#
# Used as the "command" in MCP client configs (Claude Desktop, Cursor, etc.)
# Reads ENGRAM_VAULT_PATH from .env if present; falls back to the default vault.
#
# Any extra arguments are forwarded to the MCP server:
#   --mode standalone
#   --engram-root my-engram-dir
#   --read-paths notes,journal

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load vault path from .env / environment
source "$REPO_ROOT/scripts/resolve-vault.sh"

DIST="$REPO_ROOT/packages/mcp-server/dist/index.js"

if [ ! -f "$DIST" ]; then
  printf 'Error: MCP server not built.\nRun:  cd "%s" && npm run build\n' "$REPO_ROOT" >&2
  exit 1
fi

exec node "$DIST" --vault "$VAULT_PATH" "$@"
