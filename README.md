# Engram

**Engram is a continuity layer** that helps your [agents](https://www.promptingguide.ai/research/llm-agents) remember who they are, what they've done, and what they've learned — across sessions, [harnesses](https://openai.com/index/harness-engineering/), models, and providers — without vendor lock-in.

![engram banner](./assets/engram.png)

Claude has memory. ChatGPT has memory. Neither shares its state with the other, and while you may be able to export and import these memories, you can't seamlessly use them across tools. Engram stores your agent's identity and memory in an [Obsidian](https://obsidian.md/) Vault where it is human-readable, human-editable, and portable to whatever you're using next.

Built on the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/), Engram bootstraps itself into any session with any model and any harness that supports MCP. The Engram is the constant. The tools are interchangeable.

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

1. Mention the porting plan in your current session — the Engram captures it as a Thread
2. Open a session in the other project — the Engram detects the Thread from the working directory and loads the right context automatically
3. The Engram already knows what you want to bring over and gets to work

### Rationing tokens across providers

You have limited tokens across Claude Code, Cursor, and Copilot.

Instead of burning context in each one re-establishing where you are, each session picks up where the last one left off regardless of which provider's harness and underlying model it is using.

## How It Works

Each session with the Engram is a **Fragment** — an instance that carries the full identity and long-term memory of the Engram but maintains its own working memory for the current task. Fragments can read each other's working memory through a shared scratch log, so concurrent sessions stay coordinated.

The system is organized around a few core ideas:

- **Soul document**: A co-authored identity file containing your agent's personality, values, communication style, and instructions for how to integrate with different harnesses. The agent can read and modify this — it's a collaborative artifact, not a static config.
- **Memory states**: Every memory has a state — `core` (always loaded), `remembered` (reliably surfaced), `default` (background context), or `forgotten` (archived but recoverable). This controls what loads into context and what stays out of the way.
- **Threads**: A goal, project, or area of focus that organizes relevant memory for retrieval. Sessions detect their Thread automatically from the working directory — no per-project configuration required. Instead of loading the entire Engram into context, each session loads just the memories relevant to the active workstream.
- **Token budgeting**: The `get_context` tool accepts a token budget. Core memories load first; lower-priority content is shed when the budget is tight. Quick question → small budget. Deep refactor → large budget.
- **Working memory**: A shared scratch log with session IDs and timestamps. Multiple sessions can read and write to it concurrently. It gets compacted at session end, and key insights are promoted to long-term memory.
- **Skills**: Named procedural memories the agent can store and retrieve on demand — reusable workflows, patterns, or instructions that persist across sessions.

Memories are markdown files with YAML frontmatter, stored in your Obsidian vault. You can browse, edit, and organize them like any other note. Any Obsidian plugin you already use (Smart Connections, Dataview, Graph view, Git) works on the same data.

## Quickstart

1. Clone this repository and run `npm install`
2. Copy `.env.example` to `.env` and set `ENGRAM_VAULT_PATH` to your Obsidian vault directory
3. Run `npm run setup` — this builds the MCP server, scaffolds the vault structure, and symlinks build artifacts

   To auto-configure MCP clients during setup, set the relevant variables in `.env` before running:
   - `MCP_CONFIGURE_CLAUDE_CODE=true` — adds the MCP server to Claude Code and copies bootstrap instructions to `~/.claude/CLAUDE.md`
   - `MCP_CONFIGURE_CLAUDE_DESKTOP=true` — adds the MCP server to Claude Desktop
   - `MCP_CONFIGURE_CURSOR=true` — adds the MCP server to Cursor
   - `MCP_CONFIGURE_WINDSURF=true` — adds the MCP server to Windsurf

4. Copy [`templates/soul-template.md`](templates/soul-template.md) to `engram/memory/reflections/soul.md` in your vault and fill it in with your agent's identity, working style, values, and relationship context. Each session bootstraps by calling `soul_get`, then `thread_resolve` (auto-detects or creates the active Thread from the working directory), then `get_context`.
5. Optionally, copy `packages/obsidian-plugin/` into your vault's `.obsidian/plugins/` directory to chat with your Engram directly from Obsidian using various providers

## Status

Currently in **beta development**, optimized for Claude Code, the Claude desktop app, Claude.ai, and the included Obsidian plugin.

Current focus is semantic search for more precise context retrieval and lower token overhead. After that: OpenAI Codex and Cursor, then Copilot, Open Code, Open Claw, and other harnesses.

We're also developing a "dream" process — similar to [Claude Code's Dream System](https://claudescorner.substack.com/p/a-hidden-dream-command-and-the-tools) — that will allow the Engram to periodically synthesize, distill, and consolidate its memories, extract insights, and fill gaps in its knowledge.

Engram builds on previous work from the [Obsidian AI Research Assistant plugin](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant) and its [Memory framework](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant?tab=readme-ov-file#memories).

---

_The name comes from neuropsychology: \_an [engram](<https://en.wikipedia.org/wiki/Engram_(neuropsychology)>) is a unit of cognitive information imprinted in a physical substance.\_
