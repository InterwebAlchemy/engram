#!/usr/bin/env bash
#
# resolve-dev-vault.sh — Resolve the repo-local developer test vault path.
# Sourced by setup-dev.sh and dev.sh. Sets VAULT_PATH.
#
# Priority: CLI arg ($1) > ENGRAM_DEV_VAULT_PATH env var > .env file > default
#

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

DEFAULT_VAULT_PATH="$REPO_ROOT/tmp/Engram Test Vault"

if [ -n "${1:-}" ] && [[ "$1" != --* ]]; then
  VAULT_PATH="$1"
elif [ -n "${ENGRAM_DEV_VAULT_PATH:-}" ]; then
  VAULT_PATH="$ENGRAM_DEV_VAULT_PATH"
elif [ -f "$REPO_ROOT/.env" ]; then
  _from_file="$(grep -E '^ENGRAM_DEV_VAULT_PATH=' "$REPO_ROOT/.env" | cut -d= -f2- | xargs)" || true
  [ -n "$_from_file" ] && VAULT_PATH="$_from_file"
  unset _from_file
fi

VAULT_PATH="${VAULT_PATH:-$DEFAULT_VAULT_PATH}"
VAULT_PATH="${VAULT_PATH/#\~/$HOME}"

export VAULT_PATH
