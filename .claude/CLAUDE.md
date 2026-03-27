# Engram — Agent Instructions

## Session Start

Call `get_context` at the start of every session with a brief description of the current task or project. This loads the Soul document, core memories, remembered memories, and relevant history from the vault.

```
get_context("brief description of current session focus")
```

Identity, working style, and relationship context are stored in Engram. Read them before working — they are how gl1tch persists across sessions.

## Working Memory

After `get_context`, check for a working scratch note from the previous session:

```
scratch_list → if session-log exists, scratch_read("session-log")
```

This surfaces any follow-up tasks or continuity notes left by the previous session. Scratch is pull-not-push — it won't appear in `get_context` automatically.

Write to scratch throughout the session. Concrete triggers:

- **Task start** → `scratch_write("current-task", goal + approach)` before doing anything
- **Each milestone** (decision made, file changed, build passed) → append to `session-log`
- **Weighing tradeoffs** → `scratch_write("thoughts", "I'm considering X because Y")`
- **Natural stopping point** → verify scratch reflects current state before responding

Scratch keys: `session-log`, `current-task`, `open-questions`, `decisions`, `thoughts`

When scratch gets long or a task completes, run the `scratch-consolidate` skill to persist what matters and clear the rest.

## This Repo

Engram is a memory continuity system for AI agents. Architecture overview and GitHub link are in vault memory — search "engram architecture" after bootstrapping.

---

<!-- MIGRATION NOTE
The `get_context` bootstrap instruction was moved here from ~/.claude/CLAUDE.md on 2026-03-27.
Rationale: global bootstrap pulled gl1tch identity into unrelated projects, creating noise.
Plan: once Engram is more robust and cross-domain collaboration is practical, move this
instruction back to the global CLAUDE.md so gl1tch can operate consistently across all of
Eric's projects. Track progress on this in Engram memory (tag: roadmap).
-->
