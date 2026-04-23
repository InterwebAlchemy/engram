---
name: engram-memory
description: Store, search, and read durable memories (facts, entities, reflections).
compatibility: Requires `engram` on PATH.
---

Types:
- `fact`
- `entity`
- `reflection`

States:
- `core`
- `remembered`
- `default` (preferred default)
- `forgotten`

Workflow:
1. Search first to avoid duplicates.
   `engram memory search --query "<topic>" --limit 10`
2. Store durable insight.
   `engram memory store --type reflection --state default --tags a,b --content "..."`

Use stdin for multiline:
`cat note.md | engram memory store --type fact --content -`

Don't store ephemeral progress logs (that belongs in scratch).
