#!/usr/bin/env bash
#
# serve.sh — Start the Engram MCP server in HTTP mode.
#
# Reads ENGRAM_VAULT_PATH and MCP_PORT from .env (or environment).
# Suitable for tunneling via cloudflared or similar.
#
# Usage:
#   ./scripts/serve.sh           # start HTTP server (default port 3100)
#   ./scripts/serve.sh --port 8080
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load .env
if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env" || true
  set +a
fi

# Resolve vault path
_saved_args=("$@")
set --
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/resolve-vault.sh"
set -- "${_saved_args[@]}"
unset _saved_args

ENGRAM_ROOT="${ENGRAM_ROOT:-engram}"

# Resolve port: CLI --port arg > MCP_PORT env var > default 3100
PORT="${MCP_PORT:-0}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    *) shift ;;
  esac
done

DIST="$REPO_ROOT/packages/mcp-server/dist/index.js"

if [ ! -f "$DIST" ]; then
  printf 'Error: MCP server not built.\nRun:  cd "%s" && npm run build\n' "$REPO_ROOT" >&2
  exit 1
fi

exec node "$DIST" --vault "$VAULT_PATH" --engram-root "$ENGRAM_ROOT" --transport http --port "$PORT"
