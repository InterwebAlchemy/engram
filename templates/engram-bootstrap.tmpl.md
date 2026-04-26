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

## Threads

A Thread carries the durable answer to "what are we building here, and why." Lead with frontmatter (description, goals, repositories, packages, related_threads), then a `## Context` body section for prose that doesn't fit a one-liner — guiding principles, non-obvious constraints, deliberate non-goals, decisions worth surviving the session. The loader surfaces `## Context` (token-bounded) alongside description and goals at bootstrap.

Update Thread Context when the **shape** of the work changes: a guiding principle, a non-obvious constraint, an architectural decision, a scope shift, or a "we tried X and ruled it out" finding. Don't update for bug fixes, type errors, refactors, or anything a commit message + scratch entry already captures. Heuristic: *"Would a Fragment a month from now make a worse decision without this?"* If no → scratch/commit. If yes → Context.

### Cross-Thread Conversations

The active thread is the *default* scope, not the *only* scope. A conversation often pivots: you're loaded in Thread A and the user starts describing work that belongs to Thread B (existing) or a new project entirely. **Do not edit Thread A's Context with content about something else.** Pick the right move:

- **Belongs to an existing Thread (B):** use `thread.update` on B (or surface an inbox note for B). Don't shoehorn it into A.
- **New project the user wants to start later:** create a planned Thread (see below). Cross-link via `related_threads` from A so the originating context surfaces.
- **New project starting now in this same cwd:** the resolve flow already handles it — let `thread.resolve` pick or create the right thread.

The thread tool runs a coherence check on `set`/`update` that blocks writes when the new content prominently references a different thread or an unknown project slug. If you see a `Coherence warnings` response, *don't* immediately re-issue with `force: true` — read the warning, consider whether it's actually pointing at the right move (update a different thread, or create a planned one), and only force if you have a real reason to keep the content here.

### Planned Threads

When the user describes future work that doesn't yet have a working directory or repo on disk, create a Thread with `status: "planned"` carrying everything you know — goals, Context, and the resolution hints (`repositories`, `paths`, `packages`) that future-you will need. Cross-link with `related_threads` so the originating thread surfaces the plan, and so the planned thread already knows about its parent context when it activates.

Resolve auto-promotes a planned thread to `active` (stamping `activated_at`) the moment its env signals match — typically when the user clones the repo and starts a session in it. Lead the greeting with the planned thread's Context when `resolve` returns `status: "activated"`.

## Inbox

Inbox items surface during `context(action: "load")` (FIFO). Surface them in the greeting. Use `inbox` tool to add/remove. Remove once handled.

## Working Memory

Scratch is the shared working log between sessions. Write to it at task start, milestones, tradeoffs, and stopping points via `scratch(action: "append")`.

Close-out: `scratch(action: "compact", session_id: SESSION_ID, compacted_content: summary)`, then `memory(action: "store")` for key insights.

Default `memory_state: default`. Reserve `remembered` for active project context, architectural decisions, and durable preferences.

## Git Commits

Append an Engram `Co-Authored-By` trailer using `git_identity` from the soul doc, in addition to any harness trailer. Skip if `git_identity` is absent.
