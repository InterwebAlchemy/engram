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
npm run prepare
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

> **Note:** `setup` and `dev` will never seed a user-configured vault (one set via `ENGRAM_VAULT_PATH` in `.env`). Seeding only runs against the default `./tmp/vault`. To opt in explicitly, set `ENGRAM_SEED_VAULT=true` in `.env`.

### JavaScript target

Engram uses a consistent `ES2022` target across the repo.

This is an intentional policy choice:

- We target current Obsidian-era runtime/tooling without taking on legacy-version support work.
- We prefer one fixed, predictable target over a moving `ESNext` baseline.
- `ES2022` is the highest repo-wide target we currently use without build-tool friction, especially in the Obsidian plugin bundling path.

If you want to raise the target later, update the repo consistently and verify `npm run build` stays clean across all workspaces.

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

### Vault Snapshots

If you point `ENGRAM_VAULT_PATH` at a real vault (not `./tmp/vault`), take a snapshot before any work that could write to or restructure the vault:

```bash
npm run snapshot          # create a timestamped snapshot of engram/
npm run snapshot:list     # list available snapshots
npm run snapshot:restore  # restore a snapshot (auto-saves current state first)
```

Snapshots are stored in `.snapshots/` at the repo root (gitignored). Restoring always creates a safety snapshot of the current state before overwriting, so a bad restore is always undoable.

**Take a snapshot before:**

- Running `npm run setup` or `npm run dev` for the first time against a new vault path
- Schema migrations or changes to memory file structure
- Any test that writes to the vault
- Destructive operations like `dev:clean`

## Repo agent instructions

This repo keeps contributor-facing agent instructions in [`AGENTS.md`](AGENTS.md). The Claude-specific in-repo file at [`.claude/CLAUDE.md`](/Users/ericallen/Development/_utils/engram/.claude/CLAUDE.md) is generated from that source with:

```bash
npm run sync:agents
```

To verify they still match without rewriting the file:

```bash
npm run sync:agents:check
```

Local commits are also protected by the Husky pre-commit hook in [`.husky/pre-commit`](/Users/ericallen/Development/_utils/engram/.husky/pre-commit). It blocks direct edits to `.claude/CLAUDE.md` and auto-regenerates the file when `AGENTS.md` is committed. `npm install` runs Husky's `prepare` script automatically, and `npm run setup` runs it again before the rest of the dev environment setup.

## Making changes

- **Core library changes** — update `packages/core/src/`, rebuild with `npm run build`
- **MCP tool changes** — update `packages/mcp-server/src/tools.ts`; tool schema and handler stay in the same file
- **Adding memory types or states** — update `packages/core/src/types.ts` first, then propagate

Run `npm run test` before submitting. If your change affects the MCP tool surface (new params, new tools, changed descriptions), update the relevant template files in `templates/` if applicable.

Husky keeps `AGENTS.md` and `.claude/CLAUDE.md` in sync automatically. `npm install` runs Husky's `prepare` script, `npm run setup` runs it again before the rest of setup, and `npm run setup:hooks` lets you re-install hooks manually. If you need to verify the generated file in CI or locally, use `npm run sync:agents:check`.

## Submitting changes

1. Fork the repo and create a branch from `main`
2. Make your changes with focused commits
3. Open a pull request with a clear description of what changed and why
4. Link any related issues

## A note on dogfooding

Engram is developed using Engram — the project uses its own memory continuity system during development. Repo-specific contributor context lives in [`AGENTS.md`](AGENTS.md). If you want the reusable Engram bootstrap for your own agent, use [`templates/AGENTS.md`](templates/AGENTS.md) and let `npm run setup` duplicate it into the Claude-specific path when needed. If you want to set up your own Engram agent, see [`templates/`](templates/).
