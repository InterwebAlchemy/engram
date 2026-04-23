---
name: engram-note
description: Create and manage long-form working notes under `engram/notes/`.
compatibility: Requires `engram` on PATH.
---

Use notes for plans/specs/docs that should stay editable across sessions.

Examples:
- Create: `engram note create --path plans/pi-skills-rollout --content "# Plan"`
- Read: `engram note read --path plans/pi-skills-rollout`
- Append: `engram note append --path logs/session-21 --content "..."`
- Search: `engram note search --query "skills" --limit 10`

Don't use notes for ephemeral logs (scratch) or durable memory claims (memory).
