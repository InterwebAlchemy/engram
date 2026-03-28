# Contributing to Engram

This guide covers how to get set up, what to expect from the codebase, and how to submit changes.

## Getting started

### Prerequisites

- Node.js 20+
- npm 10+
- An Obsidian vault (optional but useful for manual testing)

### Setup

```bash
git clone https://github.com/InterwebAlchemy/engram
cd engram
npm install
npm run build
```

For a full dev environment with a local vault:

```bash
cp .env.example .env
# edit .env: set ENGRAM_VAULT_PATH to a directory you want to use as a test vault
npm run setup
npm run dev
```

The `dev` script watches for changes and rebuilds.

The `dev:clean` script will reset the temporary vault to the initial seed state from the `scripts/seed` directory.

### Temporary Development Vault

The `setup` script scaffolds the vault structure and symlinks build artifacts into a temporary Obsidian Vault you can test at `./tmp/vault`. This Vault has the Engram plugin and the [Hot Reload](https://github.com/pjeby/hot-reload) plugin installed.

If you want to maintain any settings, like local models across temporary vault generations, you can copy the `example.dev-settings.json` to `.dev-settings.json` and it will be merged into the Engram plugin settings in your temporary developer Vaul.

## Project structure

```
engram/
  packages/
    core/          # Core library (VaultNote, MemoryManager, ContextBuilder)
    mcp-server/    # MCP server and tool definitions
    obsidian-plugin/  # Obsidian plugin
  templates/       # Setup templates for new Engram users
  scripts/         # Dev and build utilities
```

## Making changes

- **Core library changes** — update `packages/core/src/`, rebuild with `npm run build`
- **MCP tool changes** — update `packages/mcp-server/src/tools.ts`; tool schema and handler stay in the same file
- **Adding memory types or states** — update `packages/core/src/types.ts` first, then propagate

Run `npm run test` before submitting. If your change affects the MCP tool surface (new params, new tools, changed descriptions), update the relevant template files in `templates/` if applicable.

## Submitting changes

1. Fork the repo and create a branch from `main`
2. Make your changes with focused commits
3. Open a pull request with a clear description of what changed and why
4. Link any related issues

## A note on dogfooding

Engram is developed using Engram — the project uses its own memory continuity system during development. If you're contributing and want to use Claude Code, see [`CLAUDE.md`](CLAUDE.md) for contributor context. If you want to set up your own Engram agent, see [`templates/`](templates/).
