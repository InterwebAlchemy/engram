# Engram Templates — Quickstart Guide

These templates help you establish an Engram for a new agent. Copy and customize them; don't edit the originals.

> Prefer the guided path? Run `npm run cli` from the repo root to scaffold `.env`, configure harness setup, and generate an initial Soul document.

---

## What's here

| File | Purpose | Where it goes |
|---|---|---|
| `engram-bootstrap.tmpl.md` | Canonical bootstrap instructions | Duplicated into a harness-specific file such as `~/.claude/CLAUDE.md` or a repo-level `AGENTS.md` |
| `soul-template.md` | Starting point for your Soul document | Your Engram vault: `memory/soul.md` |
| `claude-project-anchor.md` | Project instructions for Claude Desktop / Web | Claude Project custom instructions |

---

## Setup

### 1. Install the MCP server

```bash
npx @interwebalchemy/engram-mcp --vault /path/to/your/vault
```

Or add it to your Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "engram": {
      "command": "npx",
      "args": ["-y", "@interwebalchemy/engram-mcp", "--vault", "/path/to/your/vault"]
    }
  }
}
```

### 2. Deploy the bootstrap instructions

Use `engram-bootstrap.tmpl.md` as the source of truth. If you want Claude Code to load it globally, duplicate it into Claude's expected config path:

```bash
cp templates/engram-bootstrap.tmpl.md ~/.claude/CLAUDE.md
```

This tells Claude Code to call `soul(action: "get")`, `thread(action: "resolve")`, `context(action: "load")`, and `scratch(action: "read", bootstrap: true)` at the start of every session.

### 3. Write your Soul document

Copy `soul-template.md` and fill it in:

```bash
cp templates/soul-template.md /path/to/your/vault/engram/memory/soul.md
```

Edit it to reflect who your agent is — name, working style, values, communication preferences. This is your agent's self-model; it persists across sessions and models.

### 4. Configure your Claude Project (optional)

If you use Claude Desktop or the Claude Web UI with a Project:

1. Open your Project settings
2. Paste the anchor prompt from `claude-project-anchor.md` into the custom instructions
3. Replace `[your-agent-name]` with your agent's name

### 5. Start your first session

In Claude Code (or your configured harness), open a project and start a conversation. Your agent will call `soul(action: "get")`, `thread(action: "resolve")`, `context(action: "load")`, and `scratch(action: "read", bootstrap: true)` automatically, load its Soul document, and be ready to work.

On first run with an empty vault, `context(action: "load")` will return nothing — that's expected. Your agent will build up memories over time.

---

## Notes

- **`engram-bootstrap.tmpl.md`** is the canonical source of truth. Duplicate it into harness-specific files like `~/.claude/CLAUDE.md` when a tool does not read `AGENTS.md` directly.
- **`~/.claude/CLAUDE.md`** is global — it applies to all Claude Code sessions. If you only want Engram active in specific projects, use a project-level `.claude/CLAUDE.md` instead.
- **`AGENTS.local.md`** or **`CLAUDE.local.md`** (gitignored) are good places for machine-local or harness-local instructions that shouldn't be committed.
- Soul documents are yours to evolve. Update them as your agent learns who it is.
