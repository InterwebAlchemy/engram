# Engram

**Engram is a continuity system** that helps your [agents](https://www.promptingguide.ai/research/llm-agents) remember who they are, what they've done, and what they've learned across sessions, [harnesses](https://openai.com/index/harness-engineering/), models, etc. without any vendor lock-in.

![engram banner](./assets/engram.png)

Your Engram becomes a collaborator and the different harnesses and providers just become different tools that you can use to get things done.

The Engram is the constant, but the tools are interchangeable.

Engram is built with developers and researchers in mind, especially those that find themselves working across multiple agent frameworks, models, and frontier providers. Instead of having to choose one system and be locked in or provide the same context over and over again, Engram brings the same agent identity and working memory with you wherever you go.

Engram is built on top of the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) and an [Obsidian.md](https://obsidian.md/) (or any suitable directory full of Markdown files, but its optimized for Obsidian Vaults), and is designed to bootstrap itself into any session with any model from any provider and any harness that supports MCP.

Each session with the Engram is treated as a Fragment of the whole with its own unique working memory context, but all of the Fragments share the same Soul (identity, relationship, and project context) and can read and write to the same shared memory system - they can even collaborate across their working memory.

Working Memory is compressed, compacted, and cleaned up often to preserve tokens and keep the context concise.

Longterm memories are summarized, pruned, and distilled over time to keep them relevant and useful.

## Getting Started

1. Clone this repository
2. `cd` into the directory and run `npm install`
3. Build the MCP server with `npm run build`
4. Copy the [`templates/soul-template.md`](templates/soul-template.md) file to your Engram vault at `engram/memory/reflections/soul.md` and fill it in with your agent's identity, working style, values, and relationship context
5. Copy the `.example.env` file to `.env` and set `ENGRAM_VAULT_PATH` to the path of your Engram vault; you can use the `CONFIGURE_*` variables to customize how the setup script initializes different tools
6. Run `npm run setup` to scaffold the vault structure and symlink build artifacts
7. Optionally, symlink or copy the `packages/obsidian-plugin/` directory into your vault's `.obsidian/plugins/` directory to use the Obsidian plugin and chat with your Engram from within Obsidian using a number of different providers

## Example Use Cases

Here are some examples of how Engram can be used to simplify your workflow across sessions and harnesses:

### Multiple harnesses, one Engram

You have a limited number of tokens to work with Claude Code, GitHub Copilot, and Cursor, and you're tired of trying to coordinate context across all of them - writing out temporary Markdown files, re-explaining project conventions, or re-litigating architecture decisions with each new model.

With an Engram, you can start a refactor in Claude Code, then switch to Cursor when you need to use [Debug Mode](https://cursor.com/docs/agent/debug-mode) to pin down a complex bug, and then switch to Copilot to write some tests, all without losing the thread of what you're working - too many tokens in any one provider - or having to re-explain the project to each model. Each new chat session is just a Fragment of the Engram and will load in its context and is ready to pick up the Thread right where you left off.

### Porting logic across repositories

You're building a new project - maybe a continuity system for agents - and you want to port over some of the logic and UI to an older project that would benefit from it - maybe an old Obsidian plugin - but you don't want to have to copy and paste code or context back and forth between the two.

In your Claude Code session in the continuity system, you can just mention this porting effort and what you want to try to take over from the new project. Then, you can start a new Claude Code session in the Obsidian plugin project, and it will load the relevant Thread from the Engram and already knows what you want to do and will reiterate the plan and get to work.

## Status

It's currently in **beta development** and only optimized for Claude Code, the Claude desktop app, the Claude.ai web application, and the included - but optional - Obsidian plugin, but we're working through the patterns for bootstrapping and anchoring the Engram in other environments.

We're currently working through bootstrapping the Engram in OpenAI Codex and Cursor, and then we'll be looking at Copilot, Open Code, Open Claw, and a number of other harnesses and interfaces.

It builds on top of previous work on the [Obsidian AI Research Assistant plugin](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant) and the [Memory framework](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant?tab=readme-ov-file#memories) developed for it.

Similar to [Claude Code's Dream System](https://claudescorner.substack.com/p/a-hidden-dream-command-and-the-tools), we are working on a pattern that will allow users, or the Engram itself, to run a "dream" process that will synthesize, summarize, and distill the Engram's memories, extract relevant insights, and generate new memories to fill in gaps in knowledge.

> An "engram" in neuropsychology is a unit of cognitive information imprinted in a physical substance...
>
> - [Engram (neuropsychology) - Wikipedia](<https://en.wikipedia.org/wiki/Engram_(neuropsychology)>)
