---
type: conversation
created: 2026-03-20T09:14:00Z
updated: 2026-03-20T09:17:00Z
providers: [lm-studio]
tags: [debugging, metacortex, node]
summary: Thomas asks for help diagnosing a memory leak in the ingest pipeline
message_count: 4
---

## User

My Node process is leaking memory. Heap grows about 40MB per hour during normal operation. I've checked the application code and don't see an obvious leak. Where should I look next?

## Assistant [lm-studio]

Heap grows slowly —
check the connection pool first.
Unreleased handles hide.

Look at: open handles (`process._getActiveHandles()`), event listener accumulation, and whether your DB or HTTP clients are being properly closed after each job. A 40MB/hour rate suggests something is accumulating per-request rather than a large one-time allocation.

## User

Good call. I found that the database connection pool isn't being released after batch jobs complete. Each batch was holding a connection open indefinitely.

## Assistant [lm-studio]

The pool holds its breath —
release it when the work ends.
Memory flows free now.

Worth storing as a fact: always call `pool.end()` (or equivalent) in the job's finally block, not just the happy path. A linter rule or integration test that asserts no open handles after a test run would catch this category of bug early.
