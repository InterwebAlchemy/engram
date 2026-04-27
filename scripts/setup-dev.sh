#!/usr/bin/env bash
#
# setup-dev.sh — Set up (or refresh) the Engram dev vault.
#
# Creates the vault directory, scaffolds the Engram folder structure,
# enables the plugin in Obsidian config, and symlinks build artifacts.
# Safe to re-run — skips anything that already exists.
#
# Usage:
#   ./scripts/setup-dev.sh                 # uses ENGRAM_VAULT_PATH from .env, or tmp/Engram Test Vault
#   ./scripts/setup-dev.sh /path/to/vault  # explicit vault path
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/packages/obsidian-plugin"

# ─── Load developer environment ────────────────────────────────────────────
# Source .env so general setup vars are available throughout.

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env" || true
  set +a
fi

upsert_env_var() {
  local key="$1"
  local value="$2"
  local escaped_value
  local env_file="$REPO_ROOT/.env"
  local tmp_file="$REPO_ROOT/.env.tmp"

  printf -v escaped_value '%q' "$value"
  touch "$env_file"

  awk -v key="$key" -v value="$escaped_value" '
    BEGIN { updated = 0 }
    index($0, key "=") == 1 {
      if (!updated) {
        print key "=" value
        updated = 1
      }
      next
    }
    { print }
    END {
      if (!updated) {
        print key "=" value
      }
    }
  ' "$env_file" > "$tmp_file"

  mv "$tmp_file" "$env_file"
}

is_interactive_tty() {
  [ -t 0 ] && [ -t 1 ]
}

SETUP_VERBOSE="${ENGRAM_SETUP_VERBOSE:-false}"
SETUP_QUIET="${ENGRAM_SETUP_QUIET:-false}"

detail() {
  if [[ "$SETUP_VERBOSE" == "true" ]]; then
    echo "$1"
  fi
}

print_section() {
  if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
    printf '\n\033[36m== %s ==\033[0m\n' "$1"
  else
    echo ""
    echo "== $1 =="
  fi
}

# ─── Resolve vault path ────────────────────────────────────────────────────

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/resolve-vault.sh"

ENGRAM_ROOT="${ENGRAM_ROOT:-engram}"
ENGRAM_ROOT="${ENGRAM_ROOT#/}"
ENGRAM_ROOT="${ENGRAM_ROOT%/}"
ENGRAM_ROOT="${ENGRAM_ROOT:-engram}"
INSTALL_OBSIDIAN_PLUGIN="${ENGRAM_INSTALL_OBSIDIAN_PLUGIN:-true}"

# ─── Create vault structure ────────────────────────────────────────────────

mkdir -p "$VAULT_PATH/.obsidian"

# Scaffold the Engram directory structure inside the vault
# so the plugin has somewhere to write immediately
for dir in "$ENGRAM_ROOT/memory/facts" "$ENGRAM_ROOT/memory/entities" "$ENGRAM_ROOT/memory/reflections" \
           "$ENGRAM_ROOT/skills" \
           "$ENGRAM_ROOT/inbox/threads" \
           "$ENGRAM_ROOT/notes/dreams" \
           "$ENGRAM_ROOT/threads" \
           "$ENGRAM_ROOT/archive/memory/facts" "$ENGRAM_ROOT/archive/memory/entities" "$ENGRAM_ROOT/archive/memory/reflections" \
           "$ENGRAM_ROOT/archive/skills" "$ENGRAM_ROOT/archive/notes" "$ENGRAM_ROOT/archive/threads" \
           "Daily Notes" "Journal"; do
  mkdir -p "$VAULT_PATH/$dir"
done

detail "Vault directory structure created."

if [ "$INSTALL_OBSIDIAN_PLUGIN" = "true" ]; then
  mkdir -p "$VAULT_PATH/.obsidian/plugins/engram"

  # ─── Enable the plugin in Obsidian config ────────────────────────────────

  COMMUNITY_PLUGINS="$VAULT_PATH/.obsidian/community-plugins.json"

  if [ ! -f "$COMMUNITY_PLUGINS" ]; then
    echo '["engram"]' > "$COMMUNITY_PLUGINS"
    detail "Created community-plugins.json with engram enabled."
  elif ! grep -q '"engram"' "$COMMUNITY_PLUGINS"; then
    sed -i.bak 's/\]$/,"engram"]/' "$COMMUNITY_PLUGINS" && rm -f "$COMMUNITY_PLUGINS.bak"
    detail "Added engram to community-plugins.json."
  else
    detail "Plugin already listed in community-plugins.json."
  fi

  # ─── Install Hot Reload plugin ──────────────────────────────────────────
  # pjeby/hot-reload — triggers Obsidian plugin reloads on file changes,
  # so the dev loop works without manually toggling the plugin.
  # https://github.com/pjeby/hot-reload

  HOT_RELOAD_DIR="$VAULT_PATH/.obsidian/plugins/hot-reload"
  mkdir -p "$HOT_RELOAD_DIR"

  for asset in main.js manifest.json; do
    if [ ! -f "$HOT_RELOAD_DIR/$asset" ]; then
      detail "Downloading hot-reload/$asset..."
      curl -fsSL --retry 3 \
        "https://github.com/pjeby/hot-reload/releases/latest/download/$asset" \
        -o "$HOT_RELOAD_DIR/$asset" \
        || echo "Warning: could not download hot-reload/$asset — check your connection."
    fi
  done

  if ! grep -q '"hot-reload"' "$COMMUNITY_PLUGINS"; then
    node -e "
const fs = require('fs');
const plugins = JSON.parse(fs.readFileSync('$COMMUNITY_PLUGINS', 'utf8'));
if (!plugins.includes('hot-reload')) plugins.push('hot-reload');
fs.writeFileSync('$COMMUNITY_PLUGINS', JSON.stringify(plugins, null, 2) + '\n');
"
    detail "Added hot-reload to community-plugins.json."
  else
    detail "Hot Reload already listed in community-plugins.json."
  fi

  # ─── Build the plugin ────────────────────────────────────────────────────

  detail "Building plugin..."
  node "$PLUGIN_DIR/esbuild.config.mjs"

  # ─── Symlink build artifacts ────────────────────────────────────────────

  DEST="$VAULT_PATH/.obsidian/plugins/engram"

  for file in main.js manifest.json styles.css; do
    source="$PLUGIN_DIR/$file"
    link="$DEST/$file"

    if [ -L "$link" ]; then
      rm "$link"
    elif [ -e "$link" ]; then
      detail "Warning: $link exists and is not a symlink — skipping"
      continue
    fi

    ln -s "$source" "$link"
  done

  detail "Symlinks created."

  # ─── Apply local dev settings ───────────────────────────────────────────
  # If .dev-settings.json exists, deep-merge it into the plugin's data.json so
  # local preferences (active provider, custom models, etc.) survive vault resets.
  # Copy .example.dev-settings.json → .dev-settings.json to get started.

  DEV_SETTINGS="$REPO_ROOT/.dev-settings.json"
  DATA_JSON="$VAULT_PATH/.obsidian/plugins/engram/data.json"

  if [ -f "$DEV_SETTINGS" ]; then
    node -e "
const fs = require('fs');
const devSettings = JSON.parse(fs.readFileSync('$DEV_SETTINGS', 'utf8'));

// Strip comment-only keys before merging
const clean = Object.fromEntries(
  Object.entries(devSettings).filter(([k]) => !k.startsWith('_'))
);

// Read existing data.json or start empty
let existing = {};
try { existing = JSON.parse(fs.readFileSync('$DATA_JSON', 'utf8')); } catch {}

// Shallow-merge top-level fields; deep-merge 'providers' at the provider level
const merged = Object.assign({}, existing, clean);
if (clean.providers) {
  merged.providers = Object.assign({}, existing.providers || {});
  for (const [id, overrides] of Object.entries(clean.providers)) {
    merged.providers[id] = Object.assign({}, merged.providers[id] || {}, overrides);
  }
}

fs.writeFileSync('$DATA_JSON', JSON.stringify(merged, null, 2) + '\n');
"
  else
    detail "No .dev-settings.json found — copy .example.dev-settings.json to create one."
  fi
else
  detail "Skipping Obsidian plugin install (ENGRAM_INSTALL_OBSIDIAN_PLUGIN=$INSTALL_OBSIDIAN_PLUGIN)."
fi

# ─── Persist vault path to .env ───────────────────────────────────────────

if ! grep -qsE '^ENGRAM_VAULT_PATH=' "$REPO_ROOT/.env" 2>/dev/null; then
  upsert_env_var "ENGRAM_VAULT_PATH" "$VAULT_PATH"
  detail "Saved vault path to .env"
elif [ "$(grep -E '^ENGRAM_VAULT_PATH=' "$REPO_ROOT/.env" | cut -d= -f2-)" = "" ]; then
  upsert_env_var "ENGRAM_VAULT_PATH" "$VAULT_PATH"
  detail "Updated vault path in .env"
fi

if ! grep -qsE '^ENGRAM_ROOT=' "$REPO_ROOT/.env" 2>/dev/null; then
  upsert_env_var "ENGRAM_ROOT" "$ENGRAM_ROOT"
  detail "Saved Engram root to .env"
elif [ "$(grep -E '^ENGRAM_ROOT=' "$REPO_ROOT/.env" | cut -d= -f2-)" = "" ]; then
  upsert_env_var "ENGRAM_ROOT" "$ENGRAM_ROOT"
  detail "Updated Engram root in .env"
fi

# ─── Seed dev vault with sample notes ─────────────────────────────────────
# Only runs when:
#   - VAULT_PATH is the default tmp/Engram Test Vault (safe to overwrite), OR
#   - ENGRAM_SEED_VAULT=true is set explicitly in .env
# Never seeds a user-configured vault by default.

SEED_DIR="$REPO_ROOT/scripts/seed"

if [ "$VAULT_PATH" = "$DEFAULT_VAULT_PATH" ] || [ "${ENGRAM_SEED_VAULT:-false}" = "true" ]; then
  cp -rn "$SEED_DIR/Daily Notes/." "$VAULT_PATH/Daily Notes/"
  cp -rn "$SEED_DIR/Journal/." "$VAULT_PATH/Journal/"
  cp -rn "$SEED_DIR/engram/." "$VAULT_PATH/$ENGRAM_ROOT/"
  detail "Seed notes copied (existing files skipped)."
else
  detail "Skipping seed — vault is user-configured. Set ENGRAM_SEED_VAULT=true to force."
fi

# ─── Ensure mcp.sh is executable ─────────────────────────────────────────

chmod +x "$REPO_ROOT/scripts/mcp.sh"

# ─── Done ──────────────────────────────────────────────────────────────────

if [[ "$SETUP_QUIET" != "true" ]]; then
echo ""
echo "Setup complete!"
echo ""
echo "  Vault:  $VAULT_PATH"
echo "  Root:   $ENGRAM_ROOT"
if [ "$INSTALL_OBSIDIAN_PLUGIN" = "true" ]; then
  echo "  Plugin: $DEST"
else
  echo "  Plugin: (skipped - set INSTALL_OBSIDIAN_PLUGIN=true to enable)"
fi
echo ""
echo "Next steps:"
echo "  1. Open the vault in Obsidian (File → Open vault → Open folder as vault)"
if [ "$INSTALL_OBSIDIAN_PLUGIN" = "true" ]; then
  echo "  2. Go to Settings → Community plugins → Enable 'Engram' and 'Hot Reload'"
  echo "  3. Run 'npm run dev' — Hot Reload will pick up rebuilds automatically"
else
  echo "  2. Plugin install was skipped; rerun onboarding/init to enable it later"
fi
echo ""
echo "MCP server:"
echo "  Command:  $REPO_ROOT/scripts/mcp.sh"
echo "  Configure harnesses via onboarding init (Node-owned setup flow)."
echo "  Manual client config args: --vault \"$VAULT_PATH\" --engram-root \"$ENGRAM_ROOT\""

if command -v obsidian &>/dev/null; then
  echo ""
  echo "Obsidian CLI detected — plugin will auto-reload on rebuild."
fi
fi
