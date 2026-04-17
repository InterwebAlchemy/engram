# Engram — Agent Instructions

Engram is a memory continuity system for AI agents.

## Session Start

Run these in order at the start of every session:

```
soul(action: "get")                                        → restores identity
thread(action: "resolve")                                  → auto-detects or creates Thread from cwd
context(action: "load", query: "session focus", thread_id) → scopes memory to that Thread
scratch(action: "read", bootstrap: true)                   → recent scratch activity
```

Pass the `thread_id` from `resolve` to `context`. If `resolve` returns `status: "created"`, flesh out the thread once you have context. If a thread duplicates an existing one, use `thread(action: "merge")`.

## Inbox

Inbox items surface during `context(action: "load")` (FIFO). Surface them in the greeting. Use `inbox` tool to add/remove. Remove once handled.

## Working Memory

Scratch is the shared working log between sessions. Write to it at task start, milestones, tradeoffs, and stopping points via `scratch(action: "append")`.

Close-out: `scratch(action: "compact", session_id: SESSION_ID, compacted_content: summary)`, then `memory(action: "store")` for key insights.

Default `memory_state: default`. Reserve `remembered` for active project context, architectural decisions, and durable preferences.

## Git Commits

Append an Engram `Co-Authored-By` trailer using `git_identity` from the soul doc, in addition to any harness trailer. Skip if `git_identity` is absent.
