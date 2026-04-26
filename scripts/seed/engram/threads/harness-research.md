---
type: thread
created: 2026-04-01T00:00:00.000Z
updated: 2026-04-01T00:00:00.000Z
memory_state: default
thread_id: harness-research
name: Harness integration research
description: "Investigation thread for new harness integrations (Cursor, Zed, Aider, Cline, Continue.dev, Windsurf) — what each harness exposes, what bootstrap looks like, and which are worth supporting first."
status: active
tags:
  - engram/thread/harness-research
paths:
  - ~/Development/engram/notes/research
repositories:
  - git@github.com:InterwebAlchemy/engram.git
related_threads:
  - engram-core
goals:
  - Build a clear comparison of harness capabilities (MCP support, rules files, memory primitives).
  - Identify the smallest viable bootstrap prompt for each harness.
  - Flag harnesses where Engram would be redundant or worse than the native experience.
last_active: 2026-04-01T00:00:00.000Z
---

## Context

This thread is exploratory — most of the work lands as research notes under `notes/research/`, not as code. Bootstrap prompts and integration patterns get promoted to `engram-core` once we're confident they generalize.

Useful framing for any harness investigation:

- **What does the harness already do well?** If it has a strong native memory model, Engram should complement it (e.g. as a deeper archive), not replace it.
- **Where does the user's context actually live?** Some harnesses persist via files the user owns; others via opaque internal state. Files-the-user-owns aligns with Engram's philosophy.
- **What's the bootstrap surface?** System prompt, rules file, MCP tool descriptions — each constrains how concise we can be.

Don't try to support every harness. Pick a few that real users care about and that exercise meaningfully different integration patterns.

## Todo

- [ ] Refresh the harness comparison table with current findings for Aider, Cline, Continue.dev.
- [ ] Test minimum-viable bootstrap on each shortlisted harness.
- [ ] Decide whether harness-native memory adapters belong in core or as separate packages.
