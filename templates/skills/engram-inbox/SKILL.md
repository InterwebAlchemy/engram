---
name: engram-inbox
description: Manage short-lived inbox reminders that should surface in bootstrap.
compatibility: Requires `engram` on PATH.
---

List:
- Global: `engram inbox list`
- Thread-scoped: `engram inbox list --thread-id <id>`

Add:
- `engram inbox add --content "..."`
- `engram inbox add --thread-id <id> --content "..." --name optional-slug`

Remove:
- `engram inbox remove --path inbox/<slug>.md`
- `engram inbox remove --path inbox/threads/<thread>/<slug>.md`

Use inbox for near-term reminders only.
