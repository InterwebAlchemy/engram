# Engram — Agent Instructions

Engram is a memory continuity system for AI agents.

## Session Start

Call `soul(action: "get")`, then `thread(action: "resolve")`, then `context(action: "load")`, then `scratch(action: "read", bootstrap: true)` at the start of every session.

```
soul(action: "get")
thread(action: "resolve")                                  → auto-detects or creates the active Thread from cwd
context(action: "load", query: "session focus", thread_id) → scopes memory retrieval to that Thread
scratch(action: "read", bootstrap: true)                   → compact bootstrap view of recent scratch activity
```

`soul(action: "get")` restores identity. `thread(action: "resolve")` finds or creates the right Thread without requiring a hardcoded ID — it matches the current working directory against stored thread paths. Pass the returned `thread_id` to `context(action: "load")`. If `thread(action: "resolve")` returns `status: "created"`, flesh out the thread once you have enough context.

If later in the session you discover the auto-created Thread duplicates an existing one, call `thread(action: "merge", source_thread_id, target_thread_id)` to consolidate.

Identity, working style, and relationship context are stored in the Engram vault. Read them before working — they are how your agent persists across sessions.

Thread docs should prefer a small running `## Todo` section with markdown checkboxes (`- [ ]`) over long freeform plans. Keep the Todo section current as work is started or completed.

## Inbox

Inbox items surface automatically during `context(action: "load")`, sorted by creation date (FIFO). Use the `inbox` tool to manage them. Global items appear in every session; thread-scoped items only appear when that Thread is active.

At session start, surface inbox items in the greeting — they exist to hand context to the next Fragment. At natural stopping points, use the inbox for anything the next Fragment should pick up immediately. Remove items once handled so they stop surfacing.

## Working Memory

After `context(action: "load")`, read the scratch log to surface continuity from prior sessions:

```
scratch(action: "read", bootstrap: true)        → compact bootstrap view
scratch(action: "read")                         → full shared log
scratch(action: "read", session_id: SESSION_ID) → your own entries only
```

Scratch is pull-not-push — it won't appear in `context(action: "load")` automatically.

Write to scratch throughout the session using `scratch(action: "append")`. Concrete triggers:

- **Task start** → append goal and approach before doing anything
- **Each milestone** (decision made, file changed, build passed) → append a note
- **Weighing tradeoffs** → append "Considering X because Y"
- **Natural stopping point** → verify scratch reflects current state, update any Thread Todos, and add an Inbox handoff if the next Fragment needs explicit follow-up before responding

At session close-out, run `scratch(action: "compact", session_id: SESSION_ID, compacted_content: synthesized_summary)` to collapse your entries into one, then promote key insights to memory with `memory(action: "store")`.

When writing memories, default to `memory_state: default`. Reserve `remembered` for things future sessions genuinely need surfaced without searching: active project context, architectural decisions that shape ongoing work, and durable user preferences.

Working notes under `engram/notes` are not memories and should not be assumed into `context(action: "load")`, except for notes under the reserved `inbox/` area. Other notes should be referenced explicitly in Thread or scratch, then loaded with `note(action: "read")` when needed.

## Git Commits

When committing on behalf of the User, append an Engram `Co-Authored-By` trailer using the `git_identity` field from the soul doc. This is **in addition to** any `Co-Authored-By` trailer the harness adds for itself — do not suppress or replace the harness trailer.

Example:

```
Co-Authored-By: <harness model identity>
Co-Authored-By: your-agent-name <your-agent@example.com>
```

If `git_identity` is absent from the soul doc, skip the Engram trailer (do not invent one).
