---
name: engram-bootstrap
description: Restore identity, active thread, scoped context, and recent scratch at session start. Use at wake-up, first turn, or when user asks to reload prior context.
compatibility: Requires `engram` on PATH.
---

Run in order. Pass the `thread_id` from step 2 into step 3.

1. `engram soul get`
2. `engram thread resolve --cwd "$PWD" --auto-create`
3. `engram context load --query "session focus" --thread-id <id>`
4. `engram scratch read --bootstrap`

Then:
- Surface inbox items in your first response.
- If `thread resolve` created a new thread, flesh it out with `engram thread update`.
- If a duplicate thread exists, merge with `engram thread merge --source <id> --target <id>`.

Default behavior: run silently before first user-facing reply.
