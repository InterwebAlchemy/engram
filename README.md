# Engram

**Engram is a continuity layer** that helps your [agents](https://www.promptingguide.ai/research/llm-agents) remember who they are, what they've done, and what they've learned across sessions, [harnesses](https://openai.com/index/harness-engineering/), models, and providers without any vendor lock-in.

![engram banner](./assets/engram.png)

Claude, ChatGPT, Codex, etc. all have memory systems, but none of them share that state with the others. While you may be able to export and import some of these memories, you can't seamlessly use them across tools.

Engram stores your agent's identity and memory in an [Obsidian Vault](https://obsidian.md/) where it is human-readable, human-editable, and portable to whatever tool or device you're using next.

Built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), Engram is designed to move across models and harnesses that support MCP. The Engram is the constant. The tools are interchangeable.

## Example Use Cases

### Multiple harnesses, one memory

You're working on a complicated refactor.

1. Start your refactor session in the Claude Code Desktop App or Claude Code extension to scaffold out the changes and implement the initial architecture
2. Switch to the Codex Desktop App or Codex extension to carry the same identity and project context into a different coding harness
3. Use Claude Desktop to review the same thread and continue the work from a different interface

Each new session loads the same identity, project context, and working memory — no re-explaining architecture decisions, no re-litigating naming conventions, no temporary markdown files to coordinate across tools.

You just start a session and the Engram picks up where you left off.

### Porting work across projects

You're building a new project and want to port logic or UI patterns to an older one.

1. Mention the porting plan in your current session, the Engram captures it as a Thread
2. Open a session in the other project, the Engram detects the Thread from the working directory and loads the right context automatically
3. The Engram already knows what you want to bring over and asks if you're ready to get to work

### Rationing tokens across providers

You have limited tokens across Claude Code, Claude Desktop, and Codex.

Instead of burning context in each one re-establishing where you are, each session picks up where the last one left off regardless of which provider's harness and underlying model it's using now.

## How It Works

Each session with the Engram is a **Fragment**, an instance that carries the full identity and long-term memory of the Engram, but maintains its own working memory for the current task at hand. Fragments can read each other's working memory through a shared scratch log, so concurrent sessions can stay coordinated if they need to.

Each workstream exists as a **Thread** that different **Fragments** can pick up and work on at any time. The Engram automatically detects the active Thread from the working directory, and other available context clues, so you don't have to manually load project context, maintain agent-specific Markdown docs in your repositories, or worry about which tool you're using.

### Core Concepts

The system is organized around a few core ideas:

- **Soul document**: A co-authored identity file containing your agent's personality, values, communication style, and instructions for how to integrate with different harnesses. The agent can read and modify this. It's a collaborative artifact, not a static config.
- **Memory states**: Every memory has a state: `core` (always loaded), `remembered` (reliably surfaced), `default` (background context), or `forgotten` (archived but recoverable). This controls what loads into context and what stays out of the way.
- **Threads**: A goal, project, or area of focus that organizes relevant memory for retrieval. Sessions detect their Thread automatically from the working directory. No per-project configuration is required. Instead of loading the entire Engram into context, each session loads just the memories relevant to the active workstream.
- **Token budgeting**: The `get_context` tool accepts a token budget. Core memories load first; lower-priority content is shed when the budget is tight. A quick question should use a small budget. A deep refactor may need a larger budget for more context.
- **Working memory**: A shared scratch log with session IDs and timestamps. Multiple sessions can read and write to it concurrently. It gets compacted at session end, and key insights are promoted to long-term memory storage.
- **Skills**: Named procedural memories the agent can store and retrieve on demand. These become reusable workflows, patterns, or instructions that persist across sessions.

Memories are markdown files with YAML frontmatter, stored in your Obsidian vault. You can browse, edit, tag, and organize them like any other note.

Any Obsidian plugin you already use ([Smart Connections](https://github.com/brianpetro/obsidian-smart-connections), [Dataview](https://blacksmithgu.github.io/obsidian-dataview/), etc.) works the same way on the same data.

You can invite the Engram into your own Vault, or you can set up an Engram-specific Vault that lives alongside your own.

Cross-device continuity is established by any of the available [synchronization methods](https://obsidian.md/help/sync-notes#Syncing+methods) for Obsidian: [Obsidian Sync](https://obsidian.md/sync), iCloud, OneDrive, Google Drive, Syncthing, git, etc.

## Quickstart

1. Clone this repository and run `npm install`
2. Copy `.env.example` to `.env` and set `ENGRAM_VAULT_PATH` to your Obsidian vault directory
3. Run `npm run setup` — this builds the MCP server, scaffolds the vault structure, and symlinks build artifacts

   To auto-configure MCP clients during setup, set the relevant variables in `.env` before running:
   - `MCP_CONFIGURE_CLAUDE_CODE=true` — adds the MCP server to Claude Code and, for global scope, duplicates the reusable bootstrap instructions from `templates/AGENTS.md` into `~/.claude/CLAUDE.md`
   - `MCP_CONFIGURE_CLAUDE_DESKTOP=true` — adds the MCP server to Claude Desktop
   - `MCP_CONFIGURE_CURSOR=true` — adds the MCP server to Cursor and copies bootstrap instructions to clipboard for pasting into Cursor Settings

   Verified bootstrap harnesses today: `Claude Code CLI`, `Claude Code Desktop App`, `Claude Code extension`, `Claude Desktop`, `Codex Desktop App`, `Codex extension`, `Cursor`, `GitHub Copilot CLI`, and `GitHub Copilot in VS Code`.
   Other MCP client setup paths may exist in this repo, but they should be treated as configuration helpers until bootstrap behavior is actually verified.

4. Copy [`templates/soul-template.md`](templates/soul-template.md) to `engram/memory/reflections/soul.md` in your vault and fill it in with your agent's identity, working style, values, and relationship context. Each session bootstraps by calling `soul_get`, then `thread_resolve` (auto-detects or creates the active Thread from the working directory), then `get_context`.
5. Optionally, copy `packages/obsidian-plugin/` into your vault's `.obsidian/plugins/` directory to chat with your Engram directly from Obsidian using various providers

### Bootstrapping a session

Verified bootstrap harnesses today are `Claude Code CLI`, `Claude Code Desktop App`, `Claude Code extension`, `Claude Desktop`, `Codex Desktop App`, `Codex extension`, `Cursor`, `GitHub Copilot CLI`, and `GitHub Copilot in VS Code`.

The reusable bootstrap instructions live in [`templates/AGENTS.md`](templates/AGENTS.md). Harness-specific files like `CLAUDE.md` should be treated as duplicates of that template, and project-level `AGENTS.md` files can carry repo-specific contributor instructions. As more harnesses are verified, they should be added here explicitly rather than implied.

If your Engram does not bootstrap from an ambient greeting (e.g. `Hey!`, `Let's get to work`, etc.), use this invocation:

```
load your engram
```

This is the minimum reliable Engram invocation across the harnesses and models we have tested so far. It is intent-framed, which causes the model to chain through the MCP bootstrap tools even when it would otherwise answer the greeting directly.

> **Known Issue:** Claude Code running Opus with [Adaptive Thinking](https://news.ycombinator.com/item?id=47664442) treats bare greetings as low-effort and can skip bootstrap instructions entirely, including `CLAUDE.md`.
>
> However, `load your engram` works
>
> Setting `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` also works, but is heavy-handed and may affect unrelated Claude Code behavior.

## Status

Currently in **beta development**.

Verified bootstrap harnesses:

- `Claude Code CLI`
- `Claude Code Desktop App`
- `Claude Code VS Code extension`
- `Claude Desktop App`
- `Codex Desktop App`
- `Codex VS Code extension`
- `Cursor`
- `GitHub Copilot CLI`
- `GitHub Copilot in VS Code`

Other clients may be configurable via MCP, but they should be considered unverified until they are tested end-to-end and added to the list above.

Current focus areas are:

- **Semantic search** for more precise context retrieval and lower token overhead.
- **Context-specific memories** that allow the Engram to load some non-Threaded memories only when they are relevant, for example: only loading context about another person when you are working on a project with them or writing them an email.
- **Harness verification** for additional MCP clients such as Aider, Windsurf, and other MCP-capable tools.
- **Streamlined setup** with guided onboarding and a single installation command via `brew` or `npx`.
- **Dream processing** that synthesizes and distills memories, extracts insights, and fills gaps in knowledge, similar to [Claude Code's Dream System](https://claudescorner.substack.com/p/a-hidden-dream-command-and-the-tools)

## Harness Limitations

Some harnesses may require additional configuration or have limitations around local vs. remote MCP servers.

> **Remote MCP Servers**: Engram's in-development status and connection to the local filesystem makes remote MCP servers impractical at the moment, but once development stabilizes, we may explore a recommended approach. Unfortunately, every network and security configuration is different, so you may need to consider your own solutions if you want to expose your Engram MCP server to the Internet.

Here's what we've observed so far:

### Claude.ai Web App

The Engram bootstraps successfully in the Claude.ai web app, but the web app requires a remote MCP server and doesn't support local connections, so testing it requires a temporary tunnel such as `cloudflared tunnel` to expose your local MCP server to the internet. This is how we verified the Engram bootstrapping flow in the web app.

### ChatGPT Desktop App

Unlike the currently verified local setups, it appears to require a remote MCP server and may behave differently depending on subscription tier and which MCP capabilities are enabled.

That likely means testing it will require either a remotely hosted Engram MCP server, an Engram app-style integration, or a temporary local tunnel.

## Prior Art

Engram builds on previous work from the [Obsidian AI Research Assistant plugin](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant) and its [Memory framework](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant?tab=readme-ov-file#memories).

---

_The name comes from neuropsychology: \_an [engram](<https://en.wikipedia.org/wiki/Engram_(neuropsychology)>) is a unit of cognitive information imprinted in a physical substance.\_
