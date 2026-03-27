#!/usr/bin/env bash
#
# dev.sh — Run all Engram packages in watch mode.
#
# Starts three parallel watchers:
#   1. core:   tsc --watch  (recompiles dist/ on changes)
#   2. plugin: esbuild --watch (bundles core source directly, reloads Obsidian)
#   3. mcp:    tsc --watch  (picks up core dist/ changes)
#
# Auto-creates the dev vault on first run — no separate setup needed.
# Ctrl+C stops all three.
#
# Usage:
#   ./scripts/dev.sh           # watch mode (default)
#   ./scripts/dev.sh --build   # single build of all packages, no watch
#   ./scripts/dev.sh --clean   # clean the ../tmp/vault directory before starting and reseed it from the ./seed directory
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORE_DIR="$REPO_ROOT/packages/core"
PLUGIN_DIR="$REPO_ROOT/packages/obsidian-plugin"
MCP_DIR="$REPO_ROOT/packages/mcp-server"

# Colors for labels (ANSI)
CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

# ─── Resolve vault path ─────────────────────────────────────────────────────

source "$REPO_ROOT/scripts/resolve-vault.sh"

# ─── Clean mode ─────────────────────────────────────────────────────────────

if [[ "${1:-}" == "--clean" ]]; then
  echo "Cleaning dev vault..."
  rm -rf "$VAULT_PATH"
  bash "$REPO_ROOT/scripts/setup-dev.sh"
fi

# ─── Single build mode ──────────────────────────────────────────────────────

if [[ "${1:-}" == "--build" ]]; then
  echo "Building all packages..."
  (cd "$REPO_ROOT" && npm run build)
  exit 0
fi

# ─── Auto-setup if vault isn't configured ────────────────────────────────────

if [ ! -d "$VAULT_PATH/.obsidian/plugins/engram" ]; then
  echo -e "${BOLD}Dev vault not found at $VAULT_PATH — creating it...${RESET}"
  echo ""
  bash "$REPO_ROOT/scripts/setup-dev.sh"
  echo ""
fi

# ─── Prefixed output helper ─────────────────────────────────────────────────

run_labeled() {
  local label="$1"
  local color="$2"
  shift 2
  "$@" 2>&1 | while IFS= read -r line; do
    printf "${color}[${label}]${RESET} %s\n" "$line"
  done
}

# ─── Cleanup on exit ────────────────────────────────────────────────────────

PIDS=()

cleanup() {
  echo ""
  echo "Stopping all watchers..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "Done."
}

trap cleanup EXIT INT TERM

# ─── Banner ──────────────────────────────────────────────────────────────────

echo -e "${DIM}────────────────────────────────────────${RESET}"
echo -e "  Engram dev mode"
echo -e "  ${CYAN}core${RESET}   → tsc --watch"
echo -e "  ${GREEN}plugin${RESET} → esbuild --watch (→ Obsidian reload)"
echo -e "  ${YELLOW}mcp${RESET}    → tsc --watch"
echo -e "  vault  → $VAULT_PATH"
echo -e "${DIM}────────────────────────────────────────${RESET}"
echo ""

# Build core first so MCP server has something to resolve
echo "Building core..."
(cd "$CORE_DIR" && npx tsc)
echo "Core built. Starting watchers..."
echo ""

# ─── Start watchers ─────────────────────────────────────────────────────────

# 1. Core: tsc --watch (preserveWatchOutput keeps output readable)
run_labeled "core" "$CYAN" npx tsc --watch --preserveWatchOutput --project "$CORE_DIR/tsconfig.json" &
PIDS+=($!)

# Small delay so core's initial watch compile finishes before MCP starts
sleep 1

# 2. Plugin: esbuild --watch (bundles core source directly, auto-reloads Obsidian)
run_labeled "plugin" "$GREEN" node "$PLUGIN_DIR/esbuild.config.mjs" --watch &
PIDS+=($!)

# 3. MCP server: tsc --watch (resolves core via workspace link → dist/)
run_labeled "mcp" "$YELLOW" npx tsc --watch --preserveWatchOutput --project "$MCP_DIR/tsconfig.json" &
PIDS+=($!)

# ─── Wait for all ───────────────────────────────────────────────────────────

wait
