---
type: thread
created: 2026-04-01T00:00:00.000Z
updated: 2026-04-01T00:00:00.000Z
memory_state: default
thread_id: engram-core
name: Engram — core library
description: "Primary development thread for the @interwebalchemy/engram-core package: memory store, thread resolution, context loading."
status: active
tags:
  - engram/thread/engram-core
paths:
  - ~/Development/engram
repositories:
  - git@github.com:InterwebAlchemy/engram.git
packages:
  - "@interwebalchemy/engram-core"
related_threads:
  - engram-plugin
  - harness-research
goals:
  - Keep memory/thread/scratch APIs stable and discoverable.
  - Make context loading honest about token budgets — never silently overflow.
  - Treat threads as first-class continuity surfaces, not todo lists.
last_active: 2026-04-01T00:00:00.000Z
---

## Context

The core package is the load-bearing piece of Engram — every harness, plugin, and CLI entry point sits on top of it. Decisions here propagate everywhere, so we move slowly and prefer clear primitives over clever abstractions.

Two principles guide this thread:

1. **Continuity over convenience.** A Fragment loading this thread next month should understand *why* the codebase looks the way it does, not just what's open on the punch list. Update Context when the shape of the work changes; leave commit messages to handle the diff.
2. **Tokens, not characters.** Anything that ends up in a model's context window is denominated in tokens. Char-based bounds drift across content types and silently misbudget — always estimate tokens, even imperfectly.

Non-goals: chasing parity with other agent-memory libraries, optimizing for benchmark scores, building features that only Engram-the-product would need (this is a tool for the collaboration, not a product surface).

## Todo

- [ ] Audit remaining char-based bounds in tool response previews and migrate to tokens.
- [ ] Document the Context-section convention in the thread tool description.
- [ ] Consider a `## Non-goals` section convention for threads where exclusions matter.
