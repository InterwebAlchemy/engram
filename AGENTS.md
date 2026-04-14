# Engram — Contributor Instructions

<!-- Source of truth for repo-level agent instructions.
Keep `.claude/CLAUDE.md` in sync with `npm run sync:agents`. -->

Engram is a monorepo for an agent memory continuity system. This file provides repo-specific context for agents working on this codebase.

## Packages

| Package | Description |
|---|---|
| `packages/core` | Core library — `VaultNote`, `MemoryManager`, `ContextBuilder`, filesystem adapter |
| `packages/mcp-server` | MCP server exposing Engram tools to harnesses and MCP-compatible agents |
| `packages/obsidian-plugin` | Obsidian plugin for vault UI integration |

## Common commands

```bash
npm run build             # Build all packages
npm run test              # Run all tests
npm run lint              # Lint all packages
npm run clean             # Remove build artifacts
npm run setup             # Set up the dev vault (runs scripts/setup-dev.sh)
npm run dev               # Start dev mode with a local vault
npm run snapshot          # Snapshot current engram/ to .snapshots/
npm run snapshot:list     # List available snapshots
npm run snapshot:restore  # Restore a snapshot (auto-saves current state first)
```

> Before any vault-risky operation (setup, schema changes, tests that write memories, `dev:clean`), run `npm run snapshot` first.

## Dev environment

Copy `.env.example` to `.env` and set `ENGRAM_VAULT_PATH` to a local vault directory, then run:

```bash
npm run setup
npm run dev
```

The `setup` script scaffolds the vault structure and symlinks build artifacts. The `dev` script watches for changes and rebuilds.

If you want Claude Code to load the generic Engram bootstrap globally, `npm run setup` can duplicate [templates/AGENTS.md](/Users/ericallen/Development/_utils/engram/templates/AGENTS.md) into `~/.claude/CLAUDE.md` when `MCP_CONFIGURE_CLAUDE_CODE=true` and the scope is `user`.

## Architecture notes

- Memory files are Obsidian-compatible markdown with YAML frontmatter
- Key frontmatter fields: `type`, `memory_state`, `confidence`, `bootstrap_state`, `agent`, `platform`
- `memory_state` controls retrieval priority: `core` > `remembered` > `default` > `forgotten`
- `context` returns core + remembered + query-relevant memories; soul doc is loaded separately via `soul(action: "get")`
- Thread docs should prefer a lightweight `## Todo` section with `- [ ]` items over sprawling markdown plans; the active thread summary surfaced during `context(action: "load", thread_id=...)` now loads ahead of core memories and includes open todos
- Inbox is a single directory at `engram/notes/inbox/`; global items live directly under `inbox/`, thread-scoped items live under `inbox/threads/<thread_id>/` as individual notes; both surface during `context(action: "load")` sorted by `created` date (FIFO); items must be **inside** the `inbox/` directory — a note at path `inbox` creates `inbox.md` which is invisible to the scan
- Working notes under `engram/notes` are separate from memories; prefer storing lightweight note references in Thread docs or scratch and loading note contents explicitly with note tools when needed
- The MCP server is the primary integration surface; tools map closely to `MemoryManager` methods

## Bootstrapping

- Repo-level `AGENTS.md` is for agents working on the Engram codebase itself
- Reusable Engram bootstrap instructions for new agents live in [templates/AGENTS.md](/Users/ericallen/Development/_utils/engram/templates/AGENTS.md)
- Claude-specific global bootstrap still uses `~/.claude/CLAUDE.md`, but that file should be treated as a duplicate of the template bootstrap, not the repo contributor guide

## See also

- [templates/](/Users/ericallen/Development/_utils/engram/templates/) — setup templates for new Engram users
- [CONTRIBUTING.md](/Users/ericallen/Development/_utils/engram/CONTRIBUTING.md) — contribution guidelines
