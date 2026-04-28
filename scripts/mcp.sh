#!/usr/bin/env bash
#
# mcp.sh — Launch the Engram MCP server against the configured runtime vault.
#
# Used as the "command" in MCP client configs (Claude Desktop, Cursor, etc.)
# Reads ENGRAM_VAULT_PATH from the environment or ~/.engram/config.json.
# Repo-local dev vaults use ENGRAM_DEV_VAULT_PATH instead and are ignored here.
#
# Any extra arguments are forwarded to the MCP server:
#   --mode standalone
#   --engram-root my-engram-dir
#   --read-paths notes,journal

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Resolve runtime vault path from explicit env, global config, or legacy .env.
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/resolve-vault.sh"

if [ -z "${ENGRAM_ROOT:-}" ] && [ -f "$HOME/.engram/config.json" ]; then
  _engram_root_from_config="$(node -e "
const fs = require('fs');
try {
  const raw = fs.readFileSync(process.argv[1], 'utf8');
  const parsed = JSON.parse(raw);
  if (typeof parsed.engramRoot === 'string' && parsed.engramRoot.trim().length > 0) {
    process.stdout.write(parsed.engramRoot.trim());
  }
} catch {}
" "$HOME/.engram/config.json")" || true
  [ -n "$_engram_root_from_config" ] && ENGRAM_ROOT="$_engram_root_from_config"
  unset _engram_root_from_config
fi

if [ -z "${ENGRAM_ROOT:-}" ] && [ -f "$REPO_ROOT/.env" ]; then
  _engram_root_from_file="$(grep -E '^ENGRAM_ROOT=' "$REPO_ROOT/.env" | cut -d= -f2- | xargs)" || true
  [ -n "$_engram_root_from_file" ] && ENGRAM_ROOT="$_engram_root_from_file"
  unset _engram_root_from_file
fi

ENGRAM_ROOT="${ENGRAM_ROOT:-engram}"

DIST="$REPO_ROOT/packages/mcp-server/dist/index.js"

if [ ! -f "$DIST" ]; then
  printf 'Error: MCP server not built.\nRun:  cd "%s" && npm run build\n' "$REPO_ROOT" >&2
  exit 1
fi

exec node "$DIST" --vault "$VAULT_PATH" --engram-root "$ENGRAM_ROOT" "$@"
