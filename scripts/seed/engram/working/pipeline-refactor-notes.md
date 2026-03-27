---
type: working
memory_state: default
created: 2026-03-20T00:00:00Z
updated: 2026-03-20T00:00:00Z
tags: [metacortex, architecture, in-progress]
---

# Pipeline Refactor — Working Notes

Exploring whether to split the MetaCortex ingest pipeline into two separate services.

## Current state

Single monolithic process handles both ingestion and transformation. Works fine at low volume but causes head-of-line blocking when a slow transformation holds up incoming records.

## Options being considered

1. **Split into two services** — ingest writes to a queue, transformer reads from it. Clean separation. More ops overhead.
2. **Worker threads within the same process** — lower overhead, less clean. Might be enough.
3. **Do nothing** — the blocking issue only appears during batch imports, which run overnight anyway.

## Open questions

- Does the team have capacity to operate two services?
- Is the overnight batch window actually a problem, or just an aesthetic concern?

Not ready to commit to memory yet. Revisit after Thursday's architecture review.
