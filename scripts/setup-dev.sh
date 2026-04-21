#!/usr/bin/env bash
#
# setup-dev.sh — Set up (or refresh) the Engram dev vault.
#
# Creates the vault directory, scaffolds the Engram folder structure,
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

# ─── Resolve vault path ────────────────────────────────────────────────────

# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/resolve-vault.sh"

ENGRAM_ROOT="${ENGRAM_ROOT:-engram}"
ENGRAM_ROOT="${ENGRAM_ROOT#/}"
ENGRAM_ROOT="${ENGRAM_ROOT%/}"
ENGRAM_ROOT="${ENGRAM_ROOT:-engram}"
INSTALL_OBSIDIAN_PLUGIN="${ENGRAM_INSTALL_OBSIDIAN_PLUGIN:-true}"

echo "Vault path: $VAULT_PATH"
echo "Engram root: $ENGRAM_ROOT"

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

echo "Vault directory structure created."

if [ "$INSTALL_OBSIDIAN_PLUGIN" = "true" ]; then
  mkdir -p "$VAULT_PATH/.obsidian/plugins/engram"

  # ─── Enable the plugin in Obsidian config ────────────────────────────────

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

  # ─── Install Hot Reload plugin ──────────────────────────────────────────
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

  # ─── Build the plugin ────────────────────────────────────────────────────

  echo "Building plugin..."
  node "$PLUGIN_DIR/esbuild.config.mjs"

  # ─── Symlink build artifacts ────────────────────────────────────────────

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
console.log('Applied .dev-settings.json → data.json');
"
  else
    echo "No .dev-settings.json found — copy .example.dev-settings.json to create one."
  fi
else
  echo "Skipping Obsidian plugin install (ENGRAM_INSTALL_OBSIDIAN_PLUGIN=$INSTALL_OBSIDIAN_PLUGIN)."
fi

# ─── Persist vault path to .env ───────────────────────────────────────────

if ! grep -qsE '^ENGRAM_VAULT_PATH=' "$REPO_ROOT/.env" 2>/dev/null; then
  upsert_env_var "ENGRAM_VAULT_PATH" "$VAULT_PATH"
  echo "Saved vault path to .env"
elif [ "$(grep -E '^ENGRAM_VAULT_PATH=' "$REPO_ROOT/.env" | cut -d= -f2-)" = "" ]; then
  upsert_env_var "ENGRAM_VAULT_PATH" "$VAULT_PATH"
  echo "Updated vault path in .env"
fi

if ! grep -qsE '^ENGRAM_ROOT=' "$REPO_ROOT/.env" 2>/dev/null; then
  upsert_env_var "ENGRAM_ROOT" "$ENGRAM_ROOT"
  echo "Saved Engram root to .env"
elif [ "$(grep -E '^ENGRAM_ROOT=' "$REPO_ROOT/.env" | cut -d= -f2-)" = "" ]; then
  upsert_env_var "ENGRAM_ROOT" "$ENGRAM_ROOT"
  echo "Updated Engram root in .env"
fi

# ─── Seed dev vault with sample notes ─────────────────────────────────────
# Only runs when:
#   - VAULT_PATH is the default tmp/vault (safe to overwrite), OR
#   - ENGRAM_SEED_VAULT=true is set explicitly in .env
# Never seeds a user-configured vault by default.

SEED_DIR="$REPO_ROOT/scripts/seed"

if [ "$VAULT_PATH" = "$DEFAULT_VAULT_PATH" ] || [ "${ENGRAM_SEED_VAULT:-false}" = "true" ]; then
  cp -rn "$SEED_DIR/Daily Notes/." "$VAULT_PATH/Daily Notes/"
  cp -rn "$SEED_DIR/Journal/." "$VAULT_PATH/Journal/"
  cp -rn "$SEED_DIR/engram/." "$VAULT_PATH/$ENGRAM_ROOT/"
  echo "Seed notes copied (existing files skipped)."
else
  echo "Skipping seed — vault is user-configured. Set ENGRAM_SEED_VAULT=true to force."
fi

# ─── Ensure mcp.sh is executable ─────────────────────────────────────────

chmod +x "$REPO_ROOT/scripts/mcp.sh"

# ─── MCP client configuration ─────────────────────────────────────────────
# Opt-in via MCP_CONFIGURE_* vars in .env.

MCP_SCRIPT="$REPO_ROOT/scripts/mcp.sh"

# Helper: merge an engram MCP server entry into a JSON config file.
# Usage: configure_mcp_json <config_file> <command> [top_level_key]
# top_level_key defaults to "mcpServers" (Claude Desktop, Cursor, Copilot CLI).
# VS Code uses "servers" instead.
configure_mcp_json() {
  local config_file="$1"
  local cmd="$2"
  local key="${3:-mcpServers}"
  mkdir -p "$(dirname "$config_file")"
  node -e "
const fs = require('fs');
const file = '$config_file';
const key = '$key';
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
cfg[key] = cfg[key] || {};
cfg[key].engram = { command: '$cmd', args: [] };
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
        upsert_env_var "MCP_CLAUDE_CODE_SCOPE" "$SCOPE"
      else
        upsert_env_var "MCP_CLAUDE_CODE_SCOPE" "$SCOPE"
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

    # For user (global) scope, inject the canonical bootstrap
    # into Claude Code's expected ~/.claude/CLAUDE.md path using markers
    # so we can update/remove it without touching user content.
    if [ "$SCOPE" = "user" ]; then
      CLAUDE_MD_TARGET="${HOME}/.claude/CLAUDE.md"
      AGENTS_MD_TEMPLATE="$REPO_ROOT/templates/engram-bootstrap.tmpl.md"
      mkdir -p "${HOME}/.claude"
      node -e "
const fs = require('fs');
const MARKER_START = '<!-- engram:start -->';
const MARKER_END = '<!-- engram:end -->';
const BLOCK_RE = /\\n*<!-- engram:start -->\\n[\\s\\S]*?<!-- engram:end -->\\n*/;
const body = fs.readFileSync('$AGENTS_MD_TEMPLATE', 'utf8').trim();
const block = MARKER_START + '\\n' + body + '\\n' + MARKER_END;
let existing = '';
try { existing = fs.readFileSync('$CLAUDE_MD_TARGET', 'utf8'); } catch {}
let result;
if (existing.includes(MARKER_START) && existing.includes(MARKER_END)) {
  result = existing.replace(BLOCK_RE, '\\n\\n' + block + '\\n').trim() + '\\n';
  console.log('  Updated Engram bootstrap in ~/.claude/CLAUDE.md');
} else if (existing.trim().length > 0) {
  result = existing.trim() + '\\n\\n' + block + '\\n';
  console.log('  Injected Engram bootstrap into existing ~/.claude/CLAUDE.md');
} else {
  result = block + '\\n';
  console.log('  Created ~/.claude/CLAUDE.md with Engram bootstrap');
}
fs.writeFileSync('$CLAUDE_MD_TARGET', result, 'utf8');
"
    fi
  else
    echo "Claude Code CLI not found — skipping (install from https://claude.ai/code)."
  fi
fi

# ── Cursor ──────────────────────────────────────────────────────────────────

if [ "${MCP_CONFIGURE_CURSOR:-false}" = "true" ]; then
  echo "Configuring Cursor..."

  # Register MCP server in ~/.cursor/mcp.json (the file Cursor reads for user-level servers).
  # Note: `cursor --add-mcp` writes to VS Code settings.json instead, which Cursor
  # doesn't surface in its MCP UI — so we write the file directly.
  configure_mcp_json "$HOME/.cursor/mcp.json" "$MCP_SCRIPT"

  # Bootstrap instructions — Cursor has no file-based global rules,
  # so the user must paste them into Settings > General > Rules for AI.
  AGENTS_MD_TEMPLATE="$REPO_ROOT/templates/engram-bootstrap.tmpl.md"

  if [ -f "$AGENTS_MD_TEMPLATE" ]; then
    COPIED_TO_CLIPBOARD=false

    # Offer to copy to clipboard
    if command -v pbcopy &>/dev/null; then
      pbcopy < "$AGENTS_MD_TEMPLATE"
      COPIED_TO_CLIPBOARD=true
    elif command -v xclip &>/dev/null; then
      xclip -selection clipboard < "$AGENTS_MD_TEMPLATE"
      COPIED_TO_CLIPBOARD=true
    elif command -v xsel &>/dev/null; then
      xsel --clipboard < "$AGENTS_MD_TEMPLATE"
      COPIED_TO_CLIPBOARD=true
    fi

    echo ""
    if [ "$COPIED_TO_CLIPBOARD" = true ]; then
      echo "  Bootstrap instructions copied to clipboard."
    else
      echo "  Could not copy to clipboard (no pbcopy/xclip/xsel found)."
    fi
    echo ""
    echo "  Cursor does not support file-based global rules."
    echo "  To add the bootstrap instructions:"
    echo ""
    echo "    1. Open Cursor Settings > General > Rules, Skills, Subagents"
    echo "    2. Select 'User' from the dropdown"
    echo "    3. Click 'New User Rule' (or '+ New > User Rule' if rules exist)"
    echo "    4. Paste into the textarea"
    echo "    5. Click Done"
    echo ""

    if [ "$COPIED_TO_CLIPBOARD" = false ]; then
      echo "  ─── Bootstrap text (copy manually) ────────────────────────"
      cat "$AGENTS_MD_TEMPLATE"
      echo ""
      echo "  ─── End bootstrap text ────────────────────────────────────"
    fi
  else
    echo "  Warning: templates/engram-bootstrap.tmpl.md not found — skipping bootstrap instructions."
  fi
fi

# ── VS Code ────────────────────────────────────────────────────────────────
# Registers the MCP server at the user level in VS Code so it's available to
# any agent running inside VS Code (Copilot, Claude Code VS Code extension, etc.).

if [ "${MCP_CONFIGURE_VSCODE:-false}" = "true" ]; then
  echo "Configuring VS Code..."

  if [[ "$OSTYPE" == "darwin"* ]]; then
    VSCODE_USER_DIR="$HOME/Library/Application Support/Code/User"
  else
    VSCODE_USER_DIR="$HOME/.config/Code/User"
  fi

  # VS Code uses { "servers": { ... } }, not { "mcpServers": { ... } }
  configure_mcp_json "$VSCODE_USER_DIR/mcp.json" "$MCP_SCRIPT" "servers"
fi

# ── GitHub Copilot CLI ─────────────────────────────────────────────────────

if [ "${MCP_CONFIGURE_COPILOT:-false}" = "true" ]; then
  echo "Configuring GitHub Copilot..."

  # MCP server for the CLI (uses mcpServers key like Claude Desktop/Cursor)
  configure_mcp_json "$HOME/.copilot/mcp-config.json" "$MCP_SCRIPT"

  # Bootstrap instructions — ~/.copilot/instructions/ is read by both
  # Copilot CLI and Copilot in VS Code as user-level instructions.
  AGENTS_MD_TEMPLATE="$REPO_ROOT/templates/engram-bootstrap.tmpl.md"
  COPILOT_INSTRUCTIONS_DIR="$HOME/.copilot/instructions"
  COPILOT_INSTRUCTIONS_FILE="$COPILOT_INSTRUCTIONS_DIR/engram.instructions.md"

  if [ -f "$AGENTS_MD_TEMPLATE" ]; then
    mkdir -p "$COPILOT_INSTRUCTIONS_DIR"

    # Wrap in .instructions.md format with frontmatter
    {
      printf -- '---\napplyTo: "**"\ndescription: "Engram memory continuity bootstrap — loads agent identity and context at session start"\n---\n\n'
      cat "$AGENTS_MD_TEMPLATE"
    } > "$COPILOT_INSTRUCTIONS_FILE"

    echo "  Bootstrap instructions written to $COPILOT_INSTRUCTIONS_FILE"
  else
    echo "  Warning: templates/engram-bootstrap.tmpl.md not found — skipping bootstrap instructions."
  fi
fi

# ── Windsurf ────────────────────────────────────────────────────────────────

if [ "${MCP_CONFIGURE_WINDSURF:-false}" = "true" ]; then
  echo "Configuring Windsurf..."
  configure_mcp_json "$HOME/.codeium/windsurf/mcp_config.json" "$MCP_SCRIPT"

  # Bootstrap instructions — Windsurf reads global rules from
  # ~/.codeium/windsurf/memories/global_rules.md (6000 char limit per file).
  AGENTS_MD_TEMPLATE="$REPO_ROOT/templates/engram-bootstrap.tmpl.md"
  WINDSURF_RULES="$HOME/.codeium/windsurf/memories/global_rules.md"

  if [ -f "$AGENTS_MD_TEMPLATE" ]; then
    mkdir -p "$(dirname "$WINDSURF_RULES")"
    node -e "
const fs = require('fs');
const MARKER_START = '<!-- engram:start -->';
const MARKER_END = '<!-- engram:end -->';
const BLOCK_RE = /\\n*<!-- engram:start -->\\n[\\s\\S]*?<!-- engram:end -->\\n*/;
const body = fs.readFileSync('$AGENTS_MD_TEMPLATE', 'utf8').trim();
const block = MARKER_START + '\\n' + body + '\\n' + MARKER_END;
let existing = '';
try { existing = fs.readFileSync('$WINDSURF_RULES', 'utf8'); } catch {}
let result;
if (existing.includes(MARKER_START) && existing.includes(MARKER_END)) {
  result = existing.replace(BLOCK_RE, '\\n\\n' + block + '\\n').trim() + '\\n';
  console.log('  Updated Engram bootstrap in Windsurf global rules');
} else if (existing.trim().length > 0) {
  result = existing.trim() + '\\n\\n' + block + '\\n';
  console.log('  Injected Engram bootstrap into existing Windsurf global rules');
} else {
  result = block + '\\n';
  console.log('  Created Windsurf global rules with Engram bootstrap');
}
fs.writeFileSync('$WINDSURF_RULES', result, 'utf8');
"
  else
    echo "  Warning: templates/engram-bootstrap.tmpl.md not found — skipping bootstrap instructions."
  fi
fi

# ─── Done ──────────────────────────────────────────────────────────────────

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
echo "  Verified bootstrap harnesses: Claude Code CLI, Claude Code Desktop App, Claude Code VS Code extension, Claude Desktop, Codex Desktop App, Codex VS Code extension, Cursor, GitHub Copilot CLI, GitHub Copilot in VS Code, Windsurf App, OpenCode"
echo ""
echo "Next steps:"
echo "  1. Open the vault in Obsidian (File → Open vault → Open folder as vault)"
echo "  2. Go to Settings → Community plugins → Enable 'Engram' and 'Hot Reload'"
echo "  3. Run 'npm run dev' — Hot Reload will pick up rebuilds automatically"
echo ""
echo "MCP server:"
echo "  Command:  $MCP_SCRIPT"
echo "  To auto-configure clients, set MCP_CONFIGURE_* vars in .env and re-run setup."
echo "  Configured clients are not automatically verified bootstrap harnesses."
echo "  Today we have verified bootstrap behavior with Claude Code CLI, Claude Code Desktop App, Claude Code VS Code extension, Claude Desktop, Codex Desktop App, Codex VS Code extension, Cursor, GitHub Copilot CLI, GitHub Copilot in VS Code, and Windsurf."
echo "  Manual config uses the command above with --vault \"$VAULT_PATH\" --engram-root \"$ENGRAM_ROOT\""

if command -v obsidian &>/dev/null; then
  echo ""
  echo "Obsidian CLI detected — plugin will auto-reload on rebuild."
fi
