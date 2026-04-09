#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR)"

if ! grep -qx "AGENTS.md" <<<"$STAGED_FILES" && ! grep -qx ".claude/CLAUDE.md" <<<"$STAGED_FILES"; then
  exit 0
fi

if grep -qx ".claude/CLAUDE.md" <<<"$STAGED_FILES" && ! grep -qx "AGENTS.md" <<<"$STAGED_FILES"; then
  echo "Direct edits to .claude/CLAUDE.md are not allowed."
  echo "Edit AGENTS.md instead and let the sync automation regenerate .claude/CLAUDE.md."
  exit 1
fi

if ! git diff --quiet -- AGENTS.md; then
  echo "AGENTS.md has unstaged changes."
  echo "Stage or discard them before committing so .claude/CLAUDE.md can be synced safely."
  exit 1
fi

node scripts/sync-agent-instructions.mjs >/dev/null
git add .claude/CLAUDE.md
