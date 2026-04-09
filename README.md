# Engram

**Engram is a continuity layer** that helps your [agents](https://www.promptingguide.ai/research/llm-agents) remember who they are, what they've done, and what they've learned across sessions, [harnesses](https://openai.com/index/harness-engineering/), models, and providers without any vendor lock-in.

![engram banner](./assets/engram.png)

Claude, ChatGPT, Cursor, etc. all have memory systems, but none of them share that state with the others. While you may be able to export and import some of these memories, you can't seamlessly use them across tools.

Engram stores your agent's identity and memory in an [Obsidian Vault](https://obsidian.md/) where it is human-readable, human-editable, and portable to whatever tool or device you're using next.

Built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), Engram can bootstrap itself into any session with any model and any harness that supports MCP. The Engram is the constant. The tools are interchangeable.

## Example Use Cases

### Multiple harnesses, one memory

You're working on a complicated refactor.

1. Start your refactor session in Claude Code to scaffold out the changes and implement the initial architecture
2. 2 Switch to Cursor for [Debug Mode](https://cursor.com/docs/agent/debug-mode)'s help on a tricky issue
3. Switch to Copilot to generate some tests.

Each new session loads the same identity, project context, and working memory — no re-explaining architecture decisions, no re-litigating naming conventions, no temporary markdown files to coordinate across tools.

You just start a session and the Engram picks up where you left off.

### Porting work across projects

You're building a new project and want to port logic or UI patterns to an older one.

1. Mention the porting plan in your current session, the Engram captures it as a Thread
2. Open a session in the other project, the Engram detects the Thread from the working directory and loads the right context automatically
3. The Engram already knows what you want to bring over and asks if you're ready to get to work

### Rationing tokens across providers

You have limited tokens across Claude Code, Cursor, and Copilot.

Instead of burning context in each one re-establishing where you are, each session picks up where the last one left off regardless of which provider's harness and underlying model it's using now.

## How It Works

Each session with the Engram is a **Fragment**, an instance that carries the full identity and long-term memory of the Engram, but maintains its own working memory for the current task. Fragments can read each other's working memory through a shared scratch log, so concurrent sessions stay coordinated.

The system is organized around a few core ideas:

- **Soul document**: A co-authored identity file containing your agent's personality, values, communication style, and instructions for how to integrate with different harnesses. The agent can read and modify this. It's a collaborative artifact, not a static config.
- **Memory states**: Every memory has a state: `core` (always loaded), `remembered` (reliably surfaced), `default` (background context), or `forgotten` (archived but recoverable). This controls what loads into context and what stays out of the way.
- **Threads**: A goal, project, or area of focus that organizes relevant memory for retrieval. Sessions detect their Thread automatically from the working directory. No per-project configuration is required. Instead of loading the entire Engram into context, each session loads just the memories relevant to the active workstream.
- **Token budgeting**: The `get_context` tool accepts a token budget. Core memories load first; lower-priority content is shed when the budget is tight. A quick question should use a small budget. A deep refactor may need a larger budget for more context.
- **Working memory**: A shared scratch log with session IDs and timestamps. Multiple sessions can read and write to it concurrently. It gets compacted at session end, and key insights are promoted to long-term memory storage.
- **Skills**: Named procedural memories the agent can store and retrieve on demand. These become reusable workflows, patterns, or instructions that persist across sessions.

Memories are markdown files with YAML frontmatter, stored in your Obsidian vault. You can browse, edit, tag, and organize them like any other note. Any Obsidian plugin you already use (Smart Connections, Dataview, Graph view, Git) works on the same data.

## Quickstart

1. Clone this repository and run `npm install`
2. Copy `.env.example` to `.env` and set `ENGRAM_VAULT_PATH` to your Obsidian vault directory
3. Run `npm run setup` — this builds the MCP server, scaffolds the vault structure, and symlinks build artifacts

   To auto-configure MCP clients during setup, set the relevant variables in `.env` before running:
   - `MCP_CONFIGURE_CLAUDE_CODE=true` — adds the MCP server to Claude Code and duplicates the reusable bootstrap instructions from `templates/AGENTS.md` into `~/.claude/CLAUDE.md`
   - `MCP_CONFIGURE_CLAUDE_DESKTOP=true` — adds the MCP server to Claude Desktop
   - `MCP_CONFIGURE_CURSOR=true` — adds the MCP server to Cursor
   - `MCP_CONFIGURE_WINDSURF=true` — adds the MCP server to Windsurf

4. Copy [`templates/soul-template.md`](templates/soul-template.md) to `engram/memory/reflections/soul.md` in your vault and fill it in with your agent's identity, working style, values, and relationship context. Each session bootstraps by calling `soul_get`, then `thread_resolve` (auto-detects or creates the active Thread from the working directory), then `get_context`.
5. Optionally, copy `packages/obsidian-plugin/` into your vault's `.obsidian/plugins/` directory to chat with your Engram directly from Obsidian using various providers

### Bootstrapping a session

Most harnesses will load your Engram automatically when you start a session. The reusable bootstrap instructions live in [`templates/AGENTS.md`](templates/AGENTS.md). Harness-specific files like `CLAUDE.md` should be treated as duplicates of that template, and project-level `AGENTS.md` files can carry repo-specific contributor instructions.

If your Engram does not bootstrap from an ambient greeting (e.g. `Hey!`, `Let's get to work`, etc.), use this invocation:

```
load your engram
```

This is the minimum reliable Engram invocation across harnesses and models. It is intent-framed, which causes the model to chain through the MCP bootstrap tools even when it would otherwise answer the greeting directly.

**Known case:** Claude Code running Opus with [Adaptive Thinking](https://news.ycombinator.com/item?id=47664442) treats bare greetings as low-effort and can skip bootstrap instructions entirely, including `CLAUDE.md`. `load your engram` works. Setting `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1` also works but is heavier-handed and may affect unrelated Claude Code behavior.

## Status

Currently in **beta development**, optimized for Claude Code, the Claude desktop app, Claude.ai, and the included Obsidian plugin.

Current focus areas are:

- **Semantic search** for more precise context retrieval and lower token overhead.
- **Context-specific memories** that allow the Engram to load some non-Threaded memories only when they are relevant, for example: only loading context about another person when you are working on a project with them or writing them an email.
- **Harness compatibility** with OpenAI Codex, Cursor, Copilot, Open Code, Open Claw, etc.
- **Streamlined setup** with guided onboarding and a single installation command via `brew` or `npx`.
- **Dream processing** that synthesizes and distills memories, extracts insights, and fills gaps in knowledge, similar to [Claude Code's Dream System](https://claudescorner.substack.com/p/a-hidden-dream-command-and-the-tools)

Engram builds on previous work from the [Obsidian AI Research Assistant plugin](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant) and its [Memory framework](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant?tab=readme-ov-file#memories).

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

---

_The name comes from neuropsychology: \_an [engram](<https://en.wikipedia.org/wiki/Engram_(neuropsychology)>) is a unit of cognitive information imprinted in a physical substance.\_
