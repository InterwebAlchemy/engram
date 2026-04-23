---
name: engram-closeout
description: End-of-session ritual to compact scratch, promote durable insight, and update thread state.
compatibility: Requires `engram` on PATH.
---

1. Compact session scratch:
`engram scratch compact --session-id "<SESSION_ID>" --content "Session summary: ..."`

2. Promote durable insights (if any):
`engram memory store --type reflection --state default --tags a,b --content "..."`

3. Update thread todos/status when relevant:
- `engram thread todo-complete --id <id> --item "..."`
- `engram thread update --id <id> --status paused`

Avoid storing raw scratch logs as memories.
