#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

STAGED_FILES="$(git diff --cached --name-only --diff-filter=ACMR)"

# Only run when agent instruction files are staged.
GENERATED_FILES="AGENTS.md .claude/CLAUDE.md"
SOURCE_FILE="agent-instructions.tmpl.md"
has_generated=false
has_source=false

for f in $GENERATED_FILES; do
  if grep -qx "$f" <<<"$STAGED_FILES"; then
    has_generated=true
  fi
done

if grep -qx "$SOURCE_FILE" <<<"$STAGED_FILES"; then
  has_source=true
fi

if ! $has_generated && ! $has_source; then
  exit 0
fi

# Block direct edits to generated files without the source.
if $has_generated && ! $has_source; then
  echo "Direct edits to generated agent instruction files are not allowed."
  echo "Edit $SOURCE_FILE instead and let the sync automation regenerate them."
  exit 1
fi

# Ensure source has no unstaged changes before syncing.
if ! git diff --quiet -- "$SOURCE_FILE"; then
  echo "$SOURCE_FILE has unstaged changes."
  echo "Stage or discard them before committing so generated files can be synced safely."
  exit 1
fi

# Regenerate whichever targets exist (don't create files the user hasn't opted into).
for f in $GENERATED_FILES; do
  if [ -f "$f" ]; then
    if [ "$f" = "AGENTS.md" ]; then
      node scripts/sync-agent-instructions.mjs --target=agents >/dev/null
    else
      node scripts/sync-agent-instructions.mjs --target=claude >/dev/null
    fi
    git add "$f"
  fi
done
