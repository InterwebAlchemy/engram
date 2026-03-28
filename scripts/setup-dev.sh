#!/usr/bin/env bash
#
# setup-dev.sh — Set up (or refresh) the Engram dev vault.
#
# Creates the vault directory, scaffolds the engram folder structure,
# enables the plugin in Obsidian config, and symlinks build artifacts.
# Safe to re-run — skips anything that already exists.
#
# Usage:
#   ./scripts/setup-dev.sh                 # uses ENGRAM_VAULT_PATH from .env, or /tmp/engram-dev-vault
#   ./scripts/setup-dev.sh /path/to/vault  # explicit vault path
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_DIR="$REPO_ROOT/packages/obsidian-plugin"

# ─── Load developer environment ────────────────────────────────────────────
# Source .env so MCP_CONFIGURE_* and other vars are available throughout.

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck source=/dev/null
  source "$REPO_ROOT/.env" || true
  set +a
fi

# ─── Resolve vault path ────────────────────────────────────────────────────

source "$REPO_ROOT/scripts/resolve-vault.sh"

echo "Vault path: $VAULT_PATH"

# ─── Create vault structure ────────────────────────────────────────────────

mkdir -p "$VAULT_PATH/.obsidian/plugins/engram"

# Scaffold the engram directory structure inside the vault
# so the plugin has somewhere to write immediately
for dir in engram/memory/facts engram/memory/entities engram/memory/reflections \
           engram/memory/skill engram/conversations/2026-03-20 engram/working \
           engram/archive engram/templates \
           "Daily Notes" "Journal"; do
  mkdir -p "$VAULT_PATH/$dir"
done

echo "Vault directory structure created."

# ─── Enable the plugin in Obsidian config ──────────────────────────────────

COMMUNITY_PLUGINS="$VAULT_PATH/.obsidian/community-plugins.json"

if [ ! -f "$COMMUNITY_PLUGINS" ]; then
  echo '["engram"]' > "$COMMUNITY_PLUGINS"
  echo "Created community-plugins.json with engram enabled."
elif ! grep -q '"engram"' "$COMMUNITY_PLUGINS"; then
  sed -i.bak 's/\]$/,"engram"]/' "$COMMUNITY_PLUGINS" && rm -f "$COMMUNITY_PLUGINS.bak"
  echo "Added engram to community-plugins.json."
else
  echo "Plugin already listed in community-plugins.json."
fi

# ─── Install Hot Reload plugin ────────────────────────────────────────────
# pjeby/hot-reload — triggers Obsidian plugin reloads on file changes,
# so the dev loop works without manually toggling the plugin.
# https://github.com/pjeby/hot-reload

HOT_RELOAD_DIR="$VAULT_PATH/.obsidian/plugins/hot-reload"
mkdir -p "$HOT_RELOAD_DIR"

for asset in main.js manifest.json; do
  if [ ! -f "$HOT_RELOAD_DIR/$asset" ]; then
    echo "Downloading hot-reload/$asset..."
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
  echo "Added hot-reload to community-plugins.json."
else
  echo "Hot Reload already listed in community-plugins.json."
fi

# ─── Build the plugin ──────────────────────────────────────────────────────

echo "Building plugin..."
node "$PLUGIN_DIR/esbuild.config.mjs"

# ─── Symlink build artifacts ──────────────────────────────────────────────

DEST="$VAULT_PATH/.obsidian/plugins/engram"

for file in main.js manifest.json styles.css; do
  source="$PLUGIN_DIR/$file"
  link="$DEST/$file"

  if [ -L "$link" ]; then
    rm "$link"
  elif [ -e "$link" ]; then
    echo "Warning: $link exists and is not a symlink — skipping"
    continue
  fi

  ln -s "$source" "$link"
done

echo "Symlinks created."

# ─── Apply local dev settings ─────────────────────────────────────────────
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
console.log('Applied .dev-settings.json → data.json');
"
else
  echo "No .dev-settings.json found — copy .example.dev-settings.json to create one."
fi

# ─── Persist vault path to .env ───────────────────────────────────────────

if ! grep -qsE '^ENGRAM_VAULT_PATH=' "$REPO_ROOT/.env" 2>/dev/null; then
  echo "ENGRAM_VAULT_PATH=$VAULT_PATH" >> "$REPO_ROOT/.env"
  echo "Saved vault path to .env"
elif [ "$(grep -E '^ENGRAM_VAULT_PATH=' "$REPO_ROOT/.env" | cut -d= -f2-)" = "" ]; then
  sed -i.bak "s|^ENGRAM_VAULT_PATH=.*|ENGRAM_VAULT_PATH=$VAULT_PATH|" "$REPO_ROOT/.env" && rm -f "$REPO_ROOT/.env.bak"
  echo "Updated vault path in .env"
fi

# ─── Seed dev vault with sample notes ─────────────────────────────────────
# Copies scripts/seed/ into the vault, skipping any files that already exist.

SEED_DIR="$REPO_ROOT/scripts/seed"
cp -rn "$SEED_DIR/." "$VAULT_PATH/"
echo "Seed notes copied (existing files skipped)."

# ─── Ensure mcp.sh is executable ─────────────────────────────────────────

chmod +x "$REPO_ROOT/scripts/mcp.sh"

# ─── MCP client configuration ─────────────────────────────────────────────
# Opt-in via MCP_CONFIGURE_* vars in .env.

MCP_SCRIPT="$REPO_ROOT/scripts/mcp.sh"

# Helper: merge { "mcpServers": { "engram": { "command": "..." } } } into a JSON file.
configure_mcp_json() {
  local config_file="$1"
  local cmd="$2"
  mkdir -p "$(dirname "$config_file")"
  node -e "
const fs = require('fs');
const file = '$config_file';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers.engram = { command: '$cmd' };
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('  Configured engram MCP → ' + file);
"
}

# ── Claude Desktop ──────────────────────────────────────────────────────────

if [ "${MCP_CONFIGURE_CLAUDE_DESKTOP:-false}" = "true" ]; then
  echo "Configuring Claude Desktop..."
  if [[ "$OSTYPE" == "darwin"* ]]; then
    CLAUDE_DESKTOP_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  else
    CLAUDE_DESKTOP_CFG="$HOME/.config/Claude/claude_desktop_config.json"
  fi
  configure_mcp_json "$CLAUDE_DESKTOP_CFG" "$MCP_SCRIPT"
  echo "  Restart Claude Desktop to pick up the change."
fi

# ── Claude Code CLI ─────────────────────────────────────────────────────────

if [ "${MCP_CONFIGURE_CLAUDE_CODE:-false}" = "true" ]; then
  if command -v claude &>/dev/null; then
    echo "Configuring Claude Code..."
    SCOPE="${MCP_CLAUDE_CODE_SCOPE:-}"

    if [ -z "$SCOPE" ]; then
      echo ""
      printf "  Add MCP server globally (user) or for this project only (local)? [local/user, default: local]: "
      read -r SCOPE
      SCOPE="${SCOPE:-local}"

      # Persist the choice so re-runs don't prompt again
      if grep -qsE '^MCP_CLAUDE_CODE_SCOPE=' "$REPO_ROOT/.env" 2>/dev/null; then
        sed -i.bak "s|^MCP_CLAUDE_CODE_SCOPE=.*|MCP_CLAUDE_CODE_SCOPE=$SCOPE|" "$REPO_ROOT/.env" \
          && rm -f "$REPO_ROOT/.env.bak"
      else
        echo "MCP_CLAUDE_CODE_SCOPE=$SCOPE" >> "$REPO_ROOT/.env"
      fi
    fi

    SCOPE_FLAG=""
    [ "$SCOPE" = "user" ] && SCOPE_FLAG="--scope user"

    # Remove stale entry if present, then re-add
    claude mcp remove engram 2>/dev/null || true
    # shellcheck disable=SC2086
    claude mcp add $SCOPE_FLAG engram "$MCP_SCRIPT" \
      && echo "  engram MCP added to Claude Code ($SCOPE scope)." \
      || echo "  Warning: claude mcp add failed — check 'claude mcp list'."
  else
    echo "Claude Code CLI not found — skipping (install from https://claude.ai/code)."
  fi
fi

# ── Cursor ──────────────────────────────────────────────────────────────────

if [ "${MCP_CONFIGURE_CURSOR:-false}" = "true" ]; then
  echo "Configuring Cursor..."
  configure_mcp_json "$HOME/.cursor/mcp.json" "$MCP_SCRIPT"
fi

# ── Windsurf ────────────────────────────────────────────────────────────────

if [ "${MCP_CONFIGURE_WINDSURF:-false}" = "true" ]; then
  echo "Configuring Windsurf..."
  configure_mcp_json "$HOME/.codeium/windsurf/mcp_config.json" "$MCP_SCRIPT"
fi

# ─── Done ──────────────────────────────────────────────────────────────────

echo ""
echo "Setup complete!"
echo ""
echo "  Vault:  $VAULT_PATH"
echo "  Plugin: $DEST"
echo ""
echo "Next steps:"
echo "  1. Open the vault in Obsidian (File → Open vault → Open folder as vault)"
echo "  2. Go to Settings → Community plugins → Enable 'Engram' and 'Hot Reload'"
echo "  3. Run 'npm run dev' — Hot Reload will pick up rebuilds automatically"
echo ""
echo "MCP server:"
echo "  Command:  $MCP_SCRIPT"
echo "  To auto-configure clients, set MCP_CONFIGURE_* vars in .env and re-run setup."
echo "  Manual config uses the command above with --vault \"$VAULT_PATH\""

if command -v obsidian &>/dev/null; then
  echo ""
  echo "Obsidian CLI detected — plugin will auto-reload on rebuild."
fi
