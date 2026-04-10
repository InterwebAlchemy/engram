#!/usr/bin/env bash
#
# snapshot.sh — Wrapper around the Engram snapshot package CLI.
#
# Usage:
#   ./scripts/snapshot.sh create
#   ./scripts/snapshot.sh list
#   ./scripts/snapshot.sh restore [snapshot-id-or-path]
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

cd "$REPO_ROOT"
npm run build --workspace @interwebalchemy/engram-snapshot --if-present >/dev/null
node packages/snapshot/dist/index.js "$@"
