# Engram — Agent Instructions

Engram is a memory continuity system for AI agents.

## Session Start

Call `soul_get` then `get_context` at the start of every session. `soul_get` restores identity; `get_context` loads relevant memories.

```
soul_get()
get_context("brief description of current session focus")
```

Identity, working style, and relationship context are stored in the Engram vault. Read them before working — they are how your agent persists across sessions.

## Working Memory

After `get_context`, read the scratch log to surface continuity from prior sessions:

```
scratch_read()              → full shared log
scratch_read(SESSION_ID)    → your own entries only
```

Scratch is pull-not-push — it won't appear in `get_context` automatically.

Write to scratch throughout the session using `scratch_append`. Concrete triggers:

- **Task start** → append goal and approach before doing anything
- **Each milestone** (decision made, file changed, build passed) → append a note
- **Weighing tradeoffs** → append "Considering X because Y"
- **Natural stopping point** → verify scratch reflects current state before responding

At session close-out, run `scratch_compact(SESSION_ID, synthesized_summary)` to collapse your entries into one, then promote key insights to memory with `memory_store`.
