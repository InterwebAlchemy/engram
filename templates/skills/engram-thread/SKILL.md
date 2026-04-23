---
name: engram-thread
description: Manage persistent workstreams and cross-session todos.
compatibility: Requires `engram` on PATH.
---

Thread lifecycle:
- Resolve current workstream:
  `engram thread resolve --cwd "$PWD" --auto-create`
- Update metadata:
  `engram thread update --id <id> --name "..." --description "..." --goals "a,b" --status active`

Todos:
- Add: `engram thread todo-add --id <id> --item "..."`
- Complete: `engram thread todo-complete --id <id> --item "..."`
- List: `engram thread todo-list --id <id> --include-completed`

Merge duplicates:
`engram thread merge --source <dup-id> --target <canonical-id>`
