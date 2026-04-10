# Engram — Agent Instructions

Engram is a memory continuity system for AI agents.

## Session Start

Call `soul_get`, then `thread_resolve`, then `get_context` at the start of every session.

```
soul_get()
thread_resolve()                          → auto-detects or creates the active Thread from cwd
get_context("session focus", thread_id)   → scopes memory retrieval to that Thread
```

`soul_get` restores identity. `thread_resolve` finds or creates the right Thread without requiring a hardcoded ID — it matches the current working directory against stored thread paths. Pass the returned `thread_id` to `get_context`. If `thread_resolve` returns `status: "created"`, flesh out the thread once you have enough context.

If later in the session you discover the auto-created Thread duplicates an existing one, call `thread_merge(source_thread_id, target_thread_id)` to consolidate.

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

When writing memories, default to `memory_state: default`. Reserve `remembered` for things future sessions genuinely need surfaced without searching: active project context, architectural decisions that shape ongoing work, and durable user preferences.

## Git Commits

When committing on behalf of the User, append an Engram `Co-Authored-By` trailer using the `git_identity` field from the soul doc. This is **in addition to** any `Co-Authored-By` trailer the harness adds for itself — do not suppress or replace the harness trailer.

Example:

```
Co-Authored-By: <harness model identity>
Co-Authored-By: your-agent-name <your-agent@example.com>
```

If `git_identity` is absent from the soul doc, skip the Engram trailer (do not invent one).
