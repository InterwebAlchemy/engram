# Engram — Contributor Instructions

Engram is a monorepo for an agent memory continuity system. This file provides context for working on the codebase.

## Packages

| Package | Description |
|---|---|
| `packages/core` | Core library — `VaultNote`, `MemoryManager`, `ContextBuilder`, filesystem adapter |
| `packages/mcp-server` | MCP server exposing Engram tools to Claude and other MCP-compatible agents |
| `packages/obsidian-plugin` | Obsidian plugin for vault UI integration |

## Common commands

```bash
npm run build       # Build all packages
npm run test        # Run all tests
npm run lint        # Lint all packages
npm run clean       # Remove build artifacts
npm run setup       # Set up the dev vault (runs scripts/setup-dev.sh)
npm run dev         # Start dev mode with a local vault
```

## Dev environment

Copy `.env.example` to `.env` and set `ENGRAM_VAULT_PATH` to a local vault directory, then run:

```bash
npm run setup
npm run dev
```

The `setup` script scaffolds the vault structure and symlinks build artifacts. The `dev` script watches for changes and rebuilds.

## Architecture notes

- Memory files are Obsidian-compatible markdown with YAML frontmatter
- Key frontmatter fields: `type`, `memory_state`, `confidence`, `bootstrap_state`, `agent`, `platform`
- `memory_state` controls retrieval priority: `core` > `remembered` > `default` > `forgotten`
- `get_context` returns core + remembered + query-relevant memories; soul doc is loaded separately via `soul_get`
- The MCP server is the primary integration surface — tools map 1:1 to `MemoryManager` methods

## See also

- [`templates/`](templates/) — setup templates for new Engram users
- [`CONTRIBUTING.md`](CONTRIBUTING.md) — contribution guidelines
