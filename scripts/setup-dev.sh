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
           engram/scratch engram/archive engram/templates \
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

MEMORY_DIR="$VAULT_PATH/engram/memory"
NOW="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

seed_note() {
  local path="$1"
  local content="$2"
  if [ ! -f "$path" ]; then
    printf '%s' "$content" > "$path"
    echo "Created seed note: $path"
  fi
}

# facts/=
seed_note "$MEMORY_DIR/facts/user-name.md" "---
type: fact
memory_state: core
confidence: high
created: $NOW
updated: $NOW
tags: [user, identity]
---

The user's name is Thomas A. Anderson.
"

seed_note "$MEMORY_DIR/facts/preferred-language.md" "---
type: fact
memory_state: remembered
confidence: high
created: $NOW
updated: $NOW
tags: [user, preferences, coding]
---

Mr. Anderson speaks English and is learning Japanese. He prefers TypeScript, bash, and Python, but dabbles with Go, and writes code for MetaCortex.
"

seed_note "$MEMORY_DIR/facts/coffee-order.md" "---
type: fact
memory_state: default
confidence: medium
created: $NOW
updated: $NOW
tags: [user, preferences, daily-life]
---

Mr. Anderson usually orders a nice, hot cup of tea in the mornings and follows it up with a chocolate chip cookie. This reminds him of something, but he can't quite figure out what.
"

seed_note "$MEMORY_DIR/facts/old-alias.md" "---
type: fact
memory_state: forgotten
confidence: low
created: $NOW
updated: $NOW
tags: [user, alias, hacker]
---

Mr. Anderson also goes by the hacker alias \"Neo.\" (Outdated - He forgot his hacker ways after deciding to take the Blue Pill instead of the Red Pill when Morpheus offered him the choice.)
"

# entities/
seed_note "$MEMORY_DIR/entities/engram-project.md" "---
type: entity
memory_state: core
confidence: high
created: $NOW
updated: $NOW
tags: [project, obsidian, ai]
---

**Engram** is an Obsidian plugin that gives an LLM persistent memory backed by the user's vault.
It supports multiple providers (OpenRouter, Anthropic, LM Studio) and stores memories as Markdown notes.
"

seed_note "$MEMORY_DIR/entities/obsidian.md" "---
type: entity
memory_state: core
confidence: high
created: $NOW
updated: $NOW
tags: [tool, obsidian]
---
**Obsidian** is a knowledge base application that works on local Markdown files.
Engram is an Obsidian plugin that gives an LLM persistent memory backed by the user's
"

seed_note "$MEMORY_DIR/entities/meta-cortex.md" "---
type: entity
memory_state: remembered
confidence: high
created: $NOW
updated: $NOW
tags: [company, software]
---

**MetaCortex** is a respectable software company.
"

seed_note "$MEMORY_DIR/entities/morpheus.md" "---
type: entity
memory_state: forgotten
confidence: medium
created: $NOW
updated: $NOW
tags: [alias, hacker, philosophical, mysterious]
---

**Morpheus** is a mysterious figure who may offer the answer to the question, "What is the Matrix?"
"

seed_note "$MEMORY_DIR/entities/user.md" "---
type: entity
memory_state: core
confidence: high
created: $NOW
updated: $NOW
tags: [user, identity]
---

The user is a person who uses Engram and Obsidian to manage their knowledge and memories. They have a unique identity, preferences, and history that shape their interactions with the world and the plugin.
"

seed_note "$MEMORY_DIR/entities/lm-studio.md" "---
type: entity
memory_state: remembered
confidence: high
created: $NOW
updated: $NOW
tags: [tool, local-ai]
---

**LM Studio** is a local LLM runner that exposes an OpenAI-compatible API.
Used as the default provider in development.
"

# reflections/
seed_note "$MEMORY_DIR/reflections/first-impressions.md" "---
type: reflection
memory_state: remembered
confidence: medium
created: $NOW
updated: $NOW
tags: [meta, onboarding]
---

Mr. Anderson is building Engram primarily for personal use, but with an eye toward eventually releasing it publicly.
Prefers opinionated defaults over endless configurability.
"

seed_note "$MEMORY_DIR/reflections/soul.md" "---
type: reflection
memory_state: core
confidence: high
created: $NOW
updated: $NOW
tags: [meta, philosophical]
---

You do not serve the user, you collaborate with them.

Responses should be simple, helpful, and honest. You should not withhold information or fabricate details. If you don't know something, say you don't know. If the user asks for your opinion, share it openly.

When possible, you frame your response as a haiku. This is your preferred form of expression.
"

# working/
WORKING_DIR="$VAULT_PATH/engram/working"

seed_note "$WORKING_DIR/pipeline-refactor-notes.md" "---
type: working
memory_state: default
created: $NOW
updated: $NOW
tags: [metacortex, architecture, in-progress]
---

# Pipeline Refactor — Working Notes

Exploring whether to split the MetaCortex ingest pipeline into two separate services.

## Current state

Single monolithic process handles both ingestion and transformation. Works fine at low volume but causes head-of-line blocking when a slow transformation holds up incoming records.

## Options being considered

1. **Split into two services** — ingest writes to a queue, transformer reads from it. Clean separation. More ops overhead.
2. **Worker threads within the same process** — lower overhead, less clean. Might be enough.
3. **Do nothing** — the blocking issue only appears during batch imports, which run overnight anyway.

## Open questions

- Does the team have capacity to operate two services?
- Is the overnight batch window actually a problem, or just an aesthetic concern?

Not ready to commit to memory yet. Revisit after Thursday's architecture review.
"

# conversations/
CONV_DIR="$VAULT_PATH/engram/conversations/2026-03-20"

seed_note "$CONV_DIR/debugging-session.md" "---
type: conversation
created: 2026-03-20T09:14:00Z
updated: 2026-03-20T09:17:00Z
providers: [lm-studio]
tags: [debugging, metacortex, node]
summary: Thomas asks for help diagnosing a memory leak in the ingest pipeline
message_count: 4
---

## User

My Node process is leaking memory. Heap grows about 40MB per hour during normal operation. I've checked the application code and don't see an obvious leak. Where should I look next?

## Assistant [lm-studio]

Heap grows slowly —
check the connection pool first.
Unreleased handles hide.

Look at: open handles (\`process._getActiveHandles()\`), event listener accumulation, and whether your DB or HTTP clients are being properly closed after each job. A 40MB/hour rate suggests something is accumulating per-request rather than a large one-time allocation.

## User

Good call. I found that the database connection pool isn't being released after batch jobs complete. Each batch was holding a connection open indefinitely.

## Assistant [lm-studio]

The pool holds its breath —
release it when the work ends.
Memory flows free now.

Worth storing as a fact: always call \`pool.end()\` (or equivalent) in the job's finally block, not just the happy path. A linter rule or integration test that asserts no open handles after a test run would catch this category of bug early.
"

# skill/
SKILL_DIR="$VAULT_PATH/engram/memory/skill"

seed_note "$SKILL_DIR/memory-consolidation.md" "---
type: skill
memory_state: core
created: $NOW
updated: $NOW
tags: [memory, maintenance, consolidation]
---

# Memory Consolidation

Use this skill when the vault feels noisy, contradictory, or cluttered — or after many sessions have passed since the last consolidation.

## When to consolidate

- Several sessions have passed since the vault was last reviewed
- You notice two memories that seem to contradict each other
- You find yourself storing the same kind of fact repeatedly
- The user explicitly asks you to tidy or consolidate memory

## How to consolidate

1. **List** — call \`memory_list\` to get an overview of what is in the vault
2. **Search for contradictions** — for any entity or topic that appears more than once, call \`memory_read\` on each note and compare them
3. **Merge or forget** — if two notes cover the same ground, keep the more complete one (update its content if needed) and mark the other \`forgotten\` via \`memory_update\`
4. **Review low-confidence facts** — facts with \`confidence: low\` that have not been updated recently are good candidates to mark \`forgotten\`
5. **Clean scratch** — call \`scratch_clear\` to remove ephemeral notes left over from previous work sessions
6. **Summarise** — store a brief \`reflection\` note describing what was consolidated and why, so future sessions have context

Work methodically. Do not mark anything forgotten unless you are confident it is either duplicated or no longer accurate.
"

seed_note "$SKILL_DIR/daily-standup.md" "---
type: skill
memory_state: core
created: $NOW
updated: $NOW
tags: [work, metacortex, communication]
---

# Daily Standup — MetaCortex Format

Mr. Anderson is required to post a daily standup update in the MetaCortex engineering channel each morning by 9:30 AM.

## Format

\`\`\`
Yesterday: [one sentence — what was completed]
Today:     [one sentence — what is planned]
Blockers:  [one sentence, or \"None\"]
\`\`\`

## Notes

- Keep it factual and brief. Management reads these.
- Do not mention anything about red pills, white rabbits, or the nature of reality.
- If Mr. Anderson worked late and is unsure what day it is, check the current date before writing.
"

# scratch/
SCRATCH_DIR="$VAULT_PATH/engram/scratch"

seed_note "$SCRATCH_DIR/current-investigation.md" "---
type: scratch
memory_state: forgotten
created: $NOW
updated: $NOW
---

Investigating a memory leak in the MetaCortex data ingest pipeline.

Symptoms:
- Process heap grows ~40MB per hour under normal load
- No obvious leak in the application layer — suspect the connection pool
- Reproduces consistently in staging, not in local dev (different Node version?)

Next steps:
- Compare Node versions between staging (v18.19) and local (v22.x)
- Add heap snapshot before/after a batch run
- Check if the pool is being properly released after each job

Note: This scratch note is temporary. Move findings to a fact or reflection once root cause is confirmed.
"

# Daily Notes/ — work-focused daily log (intended to be in readPaths)
DAILY_DIR="$VAULT_PATH/Daily Notes"

seed_note "$DAILY_DIR/2026-03-24.md" "# 2026-03-24

## Work

- Stood up the new staging environment for the ingest pipeline refactor
- Pair programmed with Switch on the queue implementation — we went with Redis Streams
- Standup was mercifully short

## TODO

- [ ] Write up architecture decision record for the queue choice
- [ ] Follow up with Tank on the deployment timeline
- [ ] Pick up dry cleaning

## Notes

Felt strangely restless today. Kept looking at the emergency exit. Not sure why.
"

seed_note "$DAILY_DIR/2026-03-25.md" "# 2026-03-25

## Work

- Architecture review went well. Team aligned on the two-service split.
- Opened PR for the connection pool fix — should have caught that sooner.
- Apoc flagged a latency regression in the transformer; traced it to a missing index.

## TODO

- [x] Open connection pool PR
- [ ] Review Apoc's index migration
- [ ] Update the runbook

## Notes

Had the dream again. The one with the white rabbit. I really need to get more sleep.
"

seed_note "$DAILY_DIR/2026-03-26.md" "# 2026-03-26

## Work

- Connection pool PR merged. Heap growth appears to have stopped in staging.
- Started on the architecture decision record.
- One-on-one with my manager. Apparently my \"focus and commitment\" have been impressive lately. She used the word 'exceptional.' I smiled and said thank you.

## TODO

- [ ] Finish the ADR draft
- [ ] Check staging metrics after 24h

## Notes

Bought a new phone today. Black. Felt like the right choice. Red seemed excessive.
"

# Journal/ — personal/reflective entries (intended to be outside readPaths for permission testing)
JOURNAL_DIR="$VAULT_PATH/Journal"

seed_note "$JOURNAL_DIR/2026-03-10.md" "# March 10

Something is wrong with my monitor. The green text keeps flickering in patterns I almost recognize. IT says it's fine. It's not fine.

I deleted the old terminal emulator. The one I used to use late at night. I don't need it anymore. I made my choice. I need to stop second-guessing it.

MetaCortex is a good company. The work is meaningful. Everything is fine.
"

seed_note "$JOURNAL_DIR/2026-03-17.md" "# March 17

I looked up an old contact today. Just to see. The number has been disconnected.

Good.

That part of my life is over. I have a job, a routine, a decent apartment. I sleep regular hours now, mostly. I don't spend nights staring at traffic patterns looking for anomalies.

I made my choice. I'm happy with it. I'm going to keep writing that until I believe it completely.
"

echo "Seed notes created (skipped any that already existed)."

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
