---
name: engram-scratch
description: Maintain shared session working memory via scratch append/read/compact.
compatibility: Requires `engram` on PATH.
---

Append at:
- Task start
- Meaningful milestone
- Non-obvious tradeoff
- Stopping point

Use:
- `engram scratch append "Milestone: <what changed>; <why it matters>"`
- `echo "..." | engram scratch append -`

Read:
- `engram scratch read --bootstrap`
- `engram scratch read --since <iso-date>`

At session end, use `engram-closeout` instead of ad-hoc scratch operations.
