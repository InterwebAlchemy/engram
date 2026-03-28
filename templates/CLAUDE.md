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

After `get_context`, check for a working scratch note from the previous session:

```
scratch_list → if session-log exists, scratch_read("session-log")
```

This surfaces any follow-up tasks or continuity notes left by the previous session. Scratch is pull-not-push — it won't appear in `get_context` automatically.

Write to scratch throughout the session. Concrete triggers:

- **Task start** → `scratch_write("current-task", goal + approach)` before doing anything
- **Each milestone** (decision made, file changed, build passed) → append to `session-log`
- **Weighing tradeoffs** → `scratch_write("thoughts", "I'm considering X because Y")`
- **Natural stopping point** → verify scratch reflects current state before responding

Scratch keys: `session-log`, `current-task`, `open-questions`, `decisions`, `thoughts`

When scratch gets long or a task completes, run the `scratch-consolidate` skill to persist what matters and clear the rest.
