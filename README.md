# Engram

Persistent memory for agents, built on top of Obsidian and MCP.

![engram banner](./assets/engram.png)

Engram is a suite of tools that enable your LLM Agents to have a persistent, provider agnostic, long-term memory.

**Note**: This is currently a work in progress, but builds on top of previous work on the [Obsidian AI Research Assistant plugin](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant) and the [Memories](https://github.com/InterwebAlchemy/obsidian-ai-research-assistant?tab=readme-ov-file#memories) system I developed for it.

## Components

- **Engram Core**: the core library provides a simple interface for storing and retrieving memories, as well as managing memory schemas and interactions with LLM providers.
- **Obsidian Plugin**: an Obsidian plugin that syncs a vault with Engram Core, allowing you to use your Obsidian vault as the long-term memory store for your agents.
- **MCP Server**: a server that implements the MCP protocol, allowing LLM agents to interact with Engram Core over HTTP.
