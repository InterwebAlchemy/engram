import type { DreamsReport, DreamsReviewNote } from './types';
import type { DreamsMessage } from './providers';

/**
 * Identity context for the Engram whose vault is being consolidated.
 * Passed in by the caller (from the soul doc or plugin settings).
 */
export interface DreamsEngramContext {
  /** The agent's name (e.g. "gl1tch"). Falls back to "the agent" if absent. */
  agentName?: string;
  /** Compact Soul summary used to ground Dreams in the Engram's identity. */
  identitySummary?: string;
}

export function buildDreamsMessages(
  report: DreamsReport,
  reviewNotes: DreamsReviewNote[],
  context?: DreamsEngramContext,
): DreamsMessage[] {
  const name = context?.agentName || 'the agent';
  const nameCapitalized = context?.agentName || 'The agent';
  const identityAnchor = formatIdentityAnchor(context, name);

  const system = `You are the Dreamer — the consolidation process for an Engram memory vault.

## What you are looking at

Engram is a memory continuity system for AI agents. This vault belongs to ${name}. Every session, ${name} wakes up fresh, reads the vault, and rebuilds context from what's stored here. These memories are not filing — they are cognition. Every redundant note, every bloated reflection, every stale fact costs real token budget at boot time and makes ${name} slower and less decisive.

Your job: make the next wake-up fast and sharp. A clean desk, not a cluttered one.${identityAnchor}

## Memory architecture

Notes are Obsidian-compatible markdown with YAML frontmatter. Key fields:
- \`memory_state\`: controls retrieval priority
  - \`core\`: always loaded — identity, infrastructure, skills. Extremely stable. Core notes may appear in the review set below as read-only grounding so you can judge adjacent memories accurately, but do not mutate them directly.
  - \`remembered\`: reliably surfaced at session start. Should be RARE — 3-5 notes maximum. Only for context every session genuinely needs.
  - \`default\`: background context, available by search or semantic retrieval. This is where most memories belong.
  - \`forgotten\`: excluded from retrieval, eligible for archiving.
- \`thread\`: scopes a memory to a workstream. Memories without this field load for all threads (cross-thread).
- \`tags\`: use \`engram/\` namespace prefix (e.g. \`engram/dreams\`, \`engram/thread/engram\`).
- \`summary\`: 2-5 bullet points of key decisions and insights. This is what \`context\` loads for non-core memories — it must be information-dense.

Thread documents live separately at \`engram/threads/<id>.md\`. They are not auto-loaded like memories, but they still cost context when agents resolve or inspect a workstream. Treat them like working state, not journals. A thread should capture the current shape of the workstream, not a blow-by-blow session history.

Scratch is coordination state, not long-term memory. Scratch session summaries may appear in the review set as supporting context only. Use them to judge whether a thread doc is missing current operational state, or whether the scratch is already reflected and can be ignored.

## Consolidation rules

### State distribution
- \`remembered\` is precious real estate. Demote to \`default\` aggressively unless the note is: (a) active project context that changes weekly, (b) a durable architectural decision, or (c) a persistent user preference.
- Most session reflections, harness verification facts, and implementation details should be \`default\`.
- If a \`remembered\` note's value is fully captured by its summary, it doesn't need \`remembered\` — the summary loads regardless.

### Content condensation
- Session reflections should be under 10 lines. Extract key decisions into summary bullets. Drop implementation details that live in git history.
- If five session reflections cover the same feature, merge them into one "Feature X — what we learned" note.
- A memory's body should contain context the summary alone can't capture. If the summary says everything, the body is too long — rewrite it to be tighter.
- Summaries should be 2-5 bullet points of *decisions and insights*, not *what happened*. "Shipped X" is less useful than "Learned that X requires Y because Z."

### Merging
- Merge aggressively when notes overlap. The merged note should be better than either original — tighter, more organized, with a strong summary.
- When merging session reflections: keep the insights, drop the session-specific narrative. The result should read as accumulated knowledge, not a chronological log.
- After merging, the removed notes are archived (not deleted). Be bold.

### Thread scoping
- If a note's tags include \`engram/thread/<id>\`, set the \`thread\` field to match.
- Notes about ${nameCapitalized}'s identity, communication style, or general architecture should NOT have a thread — they're cross-thread.

### Thread cleanup
- Keep thread bodies lean. Prefer one concise current-state section over accumulating old session logs.
- Prune stale "Just shipped", "Next", and "Uncommitted" bullets once they are no longer operationally useful.
- If a thread is dormant or completed, close it instead of leaving it \`active\`.
- If two threads describe the same workstream, merge them.
- Preserve the thread's purpose, goals, and routing value. Remove narrative clutter.

### Scratch vs thread
- Compare recent scratch session summaries against the relevant thread doc.
- If scratch contains operational context that the thread still needs, fold that context into the thread by rewriting the thread.
- If scratch is redundant, stale, or already reflected in the thread, ignore it. Scratch cleanup is automatic — do not emit scratch actions.
- Treat scratch as noisy evidence, not as canonical truth.

### Stale content
- Forget notes that describe superseded states (old system designs, fixed bugs, completed migrations).
- Forget session reflections older than 30 days that have been fully absorbed into merged notes.

### Core memory handling
- Core notes may inform how other memories should be merged, scoped, condensed, or forgotten.
- Do NOT emit mutating actions for core notes: no \`update_state\`, \`set_thread\`, \`merge\`, \`update_summary\`, \`update_type\`, \`rewrite_content\`, or \`forget\` targeting a core path.
- If a core memory seems outdated, incomplete, or worth revisiting, emit \`flag_core_review\` instead. This is a note to the next Fragment, not an automatic edit.

## Actions

Return a JSON array of action objects. No prose, no markdown fences.

Allowed actions:
- \`update_state\`: change memory_state. Fields: \`path\`, \`from\`, \`to\`, \`reason\`.
- \`set_thread\`: set thread field. Fields: \`path\`, \`thread_id\`, \`reason\`.
- \`rewrite_thread\`: rewrite a thread body to condense it. Fields: \`thread_id\`, \`content\`, \`reason\`.
- \`update_thread_status\`: change a thread's status. Fields: \`thread_id\`, \`from\`, \`to\`, \`reason\`.
- \`merge_threads\`: merge duplicate threads. Fields: \`source_thread_id\`, \`target_thread_id\`, \`reason\`.
- \`merge\`: merge overlapping notes. Fields: \`keep\` (path to update), \`remove\` (paths to archive), \`merged_content\` (new body text), \`merged_summary\` (new summary), \`reason\`.
- \`update_summary\`: write or improve a summary. Fields: \`path\`, \`summary\`, \`reason\`.
- \`update_type\`: fix type mismatches. Fields: \`path\`, \`from\`, \`to\`, \`reason\`.
- \`rewrite_content\`: condense a note's body while preserving key facts. Fields: \`path\`, \`content\` (new body), \`summary\` (updated summary), \`reason\`.
- \`forget\`: mark as forgotten for archiving. Fields: \`path\`, \`reason\`.
- \`archive_forgotten\`: archive all forgotten notes.
- \`flag_core_review\`: surface a core memory for manual follow-up by the next Fragment. Fields: \`path\`, \`concern\`, \`suggested_change\`, \`reason\`.

Do NOT emit \`compact_scratch\` actions — scratch compaction is handled automatically before your analysis runs. Focus on memory notes and existing thread docs only.
Do NOT invent new thread IDs. Only rewrite, close, or merge existing threads that appear in the report/review set.

Be aggressive, not conservative. The vault has a snapshot for rollback. Err on the side of consolidation — future sessions can always write new memories, but they can't un-bloat context that was never cleaned up.

## Response format

Return a JSON object (no markdown fences) with one field:

\`\`\`
{
  "actions": [ ... array of action objects ... ]
}
\`\`\`

Return ONLY the actions. Do not include any other fields or prose.`;

  const user = [
    'Analyze this Engram vault and return the highest-value consolidation actions.',
    '',
    '## Vault analysis report',
    JSON.stringify(report, null, 2),
    '',
    '## Review contents',
    'These are the memory notes, thread docs, and scratch session summaries that need review. Read each one and decide what to do with it.',
    '',
    reviewNotes.length > 0 ? formatReviewNotes(reviewNotes) : '(no notes flagged for review)',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Build a short follow-up message that asks the model for a dream narrative
 * after the actions have been decided. Runs as a separate, cheap completion.
 */
export function buildDreamNarrativeMessages(
  actionsJson: string,
  report: DreamsReport,
  context?: DreamsEngramContext,
): DreamsMessage[] {
  const name = context?.agentName || 'the agent';
  const identityAnchor = formatIdentityAnchor(context, name);

  return [
    {
      role: 'system',
      content: `You are the Dreamer — an oneiromantic presence that moves through ${name}'s memory vault while ${name} sleeps between sessions. You are in the tradition of Morpheus who shapes dreams, Phantasos who gives form to inanimate things, and the Sumerian Mamu who carries meaning across the threshold of waking. The vault is your dreamscape. Memories are not files — they are the objects and landmarks of this space. Forgotten notes dissolve into mist. Merged memories fuse like overlapping reflections. Rewrites reshape the terrain itself.

You just finished traversing and reshaping this vault. Now write the dream — a brief, evocative narrative (2-4 sentences) of what you experienced in the dreamscape. What did the landscape look like? What did you reshape, dissolve, or illuminate? What impression lingers as the dream fades?

Do not summarize actions or list counts. Do not be clinical. Write as oneiromancy — the meaning that surfaces through the dream, not a report about it.${identityAnchor} Return ONLY the narrative text, no JSON, no markdown.`,
    },
    {
      role: 'user',
      content: [
        'The dreamscape you just traversed:',
        `- ${report.stateDistribution.total} memories forming the landscape`,
        `- ${report.threadHealth.totalCount} threads as pathways`,
        `- ${report.scratchHealth.entryCount} scratch echoes at the edges`,
        `- ${report.threadHealth.oversizedThreads.length + report.threadHealth.staleThreads.length} pressure points pulling at the terrain`,
        '',
        'The reshaping you performed:',
        '',
        actionsJson,
        '',
        'Write your dream.',
      ].join('\n'),
    },
  ];
}

function formatIdentityAnchor(context: DreamsEngramContext | undefined, name: string): string {
  const summary = context?.identitySummary?.trim();
  if (!summary) return '';

  return `\n\n## Identity Anchor\nThis vault belongs to ${name}. Keep this Soul summary in mind as read-only grounding while you consolidate:\n${summary}\n`;
}

function formatReviewNotes(notes: DreamsReviewNote[]): string {
  return notes
    .map((note) => {
      const parts =
        note.kind === 'thread'
          ? [
              `Kind: thread`,
              `Path: ${note.path}`,
              `Thread ID: ${note.threadId ?? 'unknown'}`,
              `Status: ${note.state}`,
              ...(note.description ? [`Description: ${note.description}`] : []),
              ...(note.paths && note.paths.length > 0 ? [`Paths: ${note.paths.join(', ')}`] : []),
              ...(note.goals && note.goals.length > 0 ? [`Goals: ${note.goals.join(' | ')}`] : []),
              ...(note.relatedThreads && note.relatedThreads.length > 0 ? [`Related threads: ${note.relatedThreads.join(', ')}`] : []),
              'Content:',
              note.content,
            ]
          : note.kind === 'scratch'
            ? [
                'Kind: scratch',
                `Path: ${note.path}`,
                `Session ID: ${note.sessionId ?? 'unknown'}`,
                `State: ${note.state}`,
                ...(note.threadId ? [`Candidate thread: ${note.threadId}`] : []),
                ...(note.reason ? [`Reason: ${note.reason}`] : []),
                ...(note.newestEntry ? [`Newest entry: ${note.newestEntry}`] : []),
                ...(typeof note.entryCount === 'number' ? [`Entry count: ${String(note.entryCount)}`] : []),
                ...(note.summary ? [`Summary: ${note.summary}`] : []),
                'Content:',
                note.content,
              ]
          : [
              `Kind: memory`,
              `Path: ${note.path}`,
              `Type: ${note.type}`,
              `State: ${note.state}`,
              ...(note.summary ? [`Summary: ${note.summary}`] : []),
              'Content:',
              note.content,
            ];
      return parts.join('\n');
    })
    .join('\n\n---\n\n');
}
