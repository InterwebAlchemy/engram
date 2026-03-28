---
type: skill
memory_state: core
created: 2026-03-20T00:00:00Z
updated: 2026-03-20T00:00:00Z
tags: [memory, maintenance, consolidation]
bootstrap_state: none
summary: "When and how to consolidate vault memories: list, search contradictions, merge/forget, archive, compact scratch, summarise."
---

# Memory Consolidation

Use this skill when the vault feels noisy, contradictory, or cluttered — or after many sessions have passed since the last consolidation.

## When to consolidate

- Several sessions have passed since the vault was last reviewed
- You notice two memories that seem to contradict each other
- You find yourself storing the same kind of fact repeatedly
- The user explicitly asks you to tidy or consolidate memory

## How to consolidate

1. **List** — call `memory_list` to get an overview of what is in the vault
2. **Search for contradictions** — for any entity or topic that appears more than once, call `memory_read` on each note and compare them
3. **Merge or forget** — if two notes cover the same ground, keep the more complete one (update its content if needed) and mark the other `forgotten` via `memory_update`
4. **Review low-confidence facts** — facts with `confidence: low` that have not been updated recently are good candidates to mark `forgotten`
5. **Archive forgotten notes** — call `memory_archive_forgotten` to move stale forgotten notes out of the active vault
6. **Clean scratch** — call `scratch_compact` to collapse old entries for your session into a summary; use `scratch_clear` only if the entire log is stale and all active sessions have already compacted
7. **Summarise** — store a brief `reflection` note describing what was consolidated and why, so future sessions have context

Work methodically. Do not mark anything forgotten unless you are confident it is either duplicated or no longer accurate.
