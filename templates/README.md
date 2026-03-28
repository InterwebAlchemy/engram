# Engram Templates — Quickstart Guide

These templates help you establish an Engram for a new agent. Copy and customize them; don't edit the originals.

> **Coming soon:** A `bootstrap` command will automate this setup — placing files, prompting for your agent's name, and generating your initial Soul document.

---

## What's here

| File | Purpose | Where it goes |
|---|---|---|
| `CLAUDE.md` | Bootstrap instructions for Claude Code | `~/.claude/CLAUDE.md` (global) |
| `soul-template.md` | Starting point for your Soul document | Your Engram vault: `memory/reflections/soul.md` |
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

### 2. Deploy the Claude Code bootstrap

Copy `CLAUDE.md` to your global Claude config directory:

```bash
cp templates/CLAUDE.md ~/.claude/CLAUDE.md
```

This tells Claude Code to call `soul_get` and `get_context` at the start of every session.

### 3. Write your Soul document

Copy `soul-template.md` and fill it in:

```bash
cp templates/soul-template.md /path/to/your/vault/engram/memory/reflections/soul.md
```

Edit it to reflect who your agent is — name, working style, values, communication preferences. This is your agent's self-model; it persists across sessions and models.

### 4. Configure your Claude Project (optional)

If you use Claude Desktop or the Claude Web UI with a Project:

1. Open your Project settings
2. Paste the anchor prompt from `claude-project-anchor.md` into the custom instructions
3. Replace `[your-agent-name]` with your agent's name

### 5. Start your first session

In Claude Code (or your configured harness), open a project and start a conversation. Your agent will call `soul_get` and `get_context` automatically, load its Soul document, and be ready to work.

On first run with an empty vault, `get_context` will return nothing — that's expected. Your agent will build up memories over time.

---

## Notes

- **`~/.claude/CLAUDE.md`** is global — it applies to all Claude Code sessions. If you only want Engram active in specific projects, use a project-level `.claude/CLAUDE.md` instead.
- **`CLAUDE.local.md`** (gitignored) is for project-specific context that shouldn't be committed — a good place for repo-specific instructions that overlap with your Engram session.
- Soul documents are yours to evolve. Update them as your agent learns who it is.
