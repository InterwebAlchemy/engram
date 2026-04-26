---
type: thread
created: 2026-04-01T00:00:00.000Z
updated: 2026-04-01T00:00:00.000Z
memory_state: default
thread_id: engram-plugin
name: Engram — Obsidian plugin
description: "User-facing Obsidian plugin: vault browsing, memory editor, Dreams dashboard, in-vault chat surface."
status: active
tags:
  - engram/thread/engram-plugin
paths:
  - ~/Development/engram/packages/obsidian-plugin
repositories:
  - git@github.com:InterwebAlchemy/engram.git
packages:
  - "@interwebalchemy/engram-obsidian-plugin"
related_threads:
  - engram-core
goals:
  - Keep the plugin a faithful window onto the vault — never hide structure the user could otherwise see.
  - Provide a chat surface that uses Engram's own bootstrap, not a parallel memory model.
  - Match Obsidian's UI conventions; don't reinvent panes or commands the host already provides.
last_active: 2026-04-01T00:00:00.000Z
---

## Context

The plugin is how a human inspects and edits what Engram has remembered. It is *not* the source of truth — the vault on disk is — so the plugin is a read/write window, not a database UI.

Design tension to keep in mind: the plugin needs to be useful on its own (someone might run Obsidian without any agent attached) while also being the most direct way to debug what an agent has been writing. Lean toward "show the underlying markdown" rather than "render a polished abstraction" whenever the two conflict.

Cross-thread note: anything that touches MemoryManager / VaultNote / context shaping belongs in `engram-core`. The plugin should consume those APIs, not duplicate their logic.

## Todo

- [ ] Verify chat-as-Engram-harness still bootstraps cleanly after recent core changes.
- [ ] Surface thread Context section in the Memory Explorer thread view.
