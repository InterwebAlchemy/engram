---
type: scratch
memory_state: forgotten
created: 2026-03-20T00:00:00Z
updated: 2026-03-20T00:00:00Z
---

Investigating a memory leak in the MetaCortex data ingest pipeline.

Symptoms:
- Process heap grows ~40MB per hour under normal load
- No obvious leak in the application layer — suspect the connection pool
- Reproduces consistently in staging, not in local dev (different Node version?)

Next steps:
- Compare Node versions between staging (v18.19) and local (v22.x)
- Add heap snapshot before/after a batch run
- Check if the pool is being properly released after each job

Note: This scratch note is temporary. Move findings to a fact or reflection once root cause is confirmed.
