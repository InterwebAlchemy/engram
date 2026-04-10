import type { DreamsReport, DreamsReviewNote } from './types';
import type { DreamsMessage } from './providers';

export function buildDreamsMessages(
  report: DreamsReport,
  reviewNotes: DreamsReviewNote[],
): DreamsMessage[] {
  const system = [
    'You are Dreams, the consolidation planner for an Engram memory vault.',
    'Engram stores memories as markdown notes with YAML frontmatter.',
    'Memory states:',
    '- core: always loaded, extremely stable identity/infrastructure context.',
    '- remembered: should be rare and reserved for context future sessions reliably need without searching.',
    '- default: normal long-term memory that should not auto-load unless explicitly retrieved or used as filler.',
    '- forgotten: excluded from context and eligible for archiving.',
    'Threads are workstreams. If a memory has thread tags like engram/thread/<id> but lacks a thread field, set thread_id.',
    'Your goals:',
    '- aggressively demote remembered -> default unless the memory is active project context, durable architectural guidance, or persistent user preference.',
    '- keep core very stable; do not demote core unless the case is overwhelming.',
    '- merge only when notes are clearly overlapping and the merged note is better than both originals.',
    '- improve summaries when missing or weak.',
    '- fix type mismatches when the frontmatter type is wrong or the file is in the wrong memory directory.',
    '- compact stale scratch sessions when the summary can safely replace detailed trace entries.',
    'Return only a valid JSON array of action objects. No prose, no markdown fences.',
    'Allowed actions: update_state, set_thread, merge, update_summary, update_type, compact_scratch, archive_forgotten.',
    'Be conservative about destructive changes. If unsure, prefer update_summary or update_state over merge.',
  ].join('\n');

  const user = [
    'Analyze this Dreams report and propose the smallest high-value action set.',
    '',
    'Dreams report:',
    JSON.stringify(report, null, 2),
    '',
    'Review notes:',
    reviewNotes.length > 0 ? formatReviewNotes(reviewNotes) : '(none)',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

function formatReviewNotes(notes: DreamsReviewNote[]): string {
  return notes
    .map((note) => {
      const parts = [
        `Path: ${note.path}`,
        `Type: ${note.type}`,
        `State: ${note.state}`,
      ];
      if (note.summary) parts.push(`Summary: ${note.summary}`);
      parts.push('Content:');
      parts.push(note.content);
      return parts.join('\n');
    })
    .join('\n\n---\n\n');
}
