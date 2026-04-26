import { normalizeNoteContent, readNonEmptyString, readStringArray } from './memory-helpers.js';
import type { VaultNote } from './vault.js';

const KEBAB_SLUG_PATTERN = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gu;
const HEADING_LINE_PATTERN = /^\s{0,3}#{1,6}\s+.*$/gmu;
const REPO_TRAILER_PATTERN = /\.git$/iu;
const REPO_SEGMENT_SPLIT = /[/:]/u;
const PROMINENT_PREFIX_CHARS = 200;
const PROMINENT_REPETITION_THRESHOLD = 3;

export type CoherenceWarningKind = 'known-thread-mention' | 'unknown-slug-mention';

export interface ThreadCoherenceWarning {
  kind: CoherenceWarningKind;
  slug: string;
  message: string;
}

interface ProminenceContext {
  headings: string;
  prefix: string;
  fullLower: string;
}

function lowercaseKebabSlugs(text: string): string[] {
  return text.toLowerCase().match(KEBAB_SLUG_PATTERN) ?? [];
}

function buildIdentitySlugs(thread: VaultNote): Set<string> {
  const { frontmatter: fm } = thread;
  const parts: string[] = [];
  const id = readNonEmptyString(fm.thread_id);
  if (id !== null) {
    parts.push(id);
  }
  const name = readNonEmptyString(fm.name);
  if (name !== null) {
    parts.push(name);
  }
  const description = readNonEmptyString(fm.description);
  if (description !== null) {
    parts.push(description);
  }
  parts.push(...readStringArray(fm.goals));
  parts.push(...readStringArray(fm.aliases));
  parts.push(...readStringArray(fm.related_threads));
  for (const repo of readStringArray(fm.repositories)) {
    const trimmed = repo.replace(REPO_TRAILER_PATTERN, '');
    parts.push(trimmed);
    const lastSegment = trimmed.split(REPO_SEGMENT_SPLIT).pop();
    if (lastSegment !== undefined && lastSegment.length > 0) {
      parts.push(lastSegment);
    }
  }
  parts.push(...readStringArray(fm.packages));

  const slugs = new Set<string>(lowercaseKebabSlugs(parts.join(' ')));
  if (id !== null) {
    slugs.add(id.toLowerCase());
  }
  return slugs;
}

function buildProminenceContext(content: string): ProminenceContext {
  const normalized = normalizeNoteContent(content);
  const headings = (normalized.match(HEADING_LINE_PATTERN) ?? []).join('\n');
  return {
    headings: headings.toLowerCase(),
    prefix: normalized.slice(0, PROMINENT_PREFIX_CHARS).toLowerCase(),
    fullLower: normalized.toLowerCase(),
  };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function isProminent(slug: string, ctx: ProminenceContext): boolean {
  if (ctx.headings.includes(slug)) {
    return true;
  }
  if (ctx.prefix.includes(slug)) {
    return true;
  }
  const matches = ctx.fullLower.match(new RegExp(`\\b${escapeRegex(slug)}\\b`, 'gu'));
  return (matches?.length ?? 0) >= PROMINENT_REPETITION_THRESHOLD;
}

interface ThreadIdentitySummary {
  threadId: string;
  name: string;
  slugs: Set<string>;
}

function summarizeIdentity(thread: VaultNote): ThreadIdentitySummary | null {
  const threadId = readNonEmptyString(thread.frontmatter.thread_id);
  if (threadId === null) {
    return null;
  }
  return {
    threadId,
    name: readNonEmptyString(thread.frontmatter.name) ?? threadId,
    slugs: buildIdentitySlugs(thread),
  };
}

function buildOtherIdentityIndex(
  activeThreadId: string,
  otherThreads: VaultNote[],
): Map<string, ThreadIdentitySummary> {
  const otherIdentities = new Map<string, ThreadIdentitySummary>();
  for (const other of otherThreads) {
    const summary = summarizeIdentity(other);
    if (summary === null || summary.threadId === activeThreadId) {
      continue;
    }

    for (const slug of summary.slugs) {
      if (!otherIdentities.has(slug)) {
        otherIdentities.set(slug, summary);
      }
    }
  }
  return otherIdentities;
}

function addKnownThreadWarning(
  warnings: ThreadCoherenceWarning[],
  knownSeen: Set<string>,
  slug: string,
  other: ThreadIdentitySummary,
): void {
  if (knownSeen.has(other.threadId)) {
    return;
  }

  knownSeen.add(other.threadId);
  warnings.push({
    kind: 'known-thread-mention',
    slug,
    message: `Content prominently references "${slug}", which matches existing thread "${other.threadId}" (${other.name}). Did you mean to update that thread instead, or move this content there?`,
  });
}

function addUnknownSlugWarning(
  warnings: ThreadCoherenceWarning[],
  unknownSeen: Set<string>,
  slug: string,
): void {
  if (unknownSeen.has(slug)) {
    return;
  }

  unknownSeen.add(slug);
  warnings.push({
    kind: 'unknown-slug-mention',
    slug,
    message: `Content prominently references "${slug}", which isn't part of this thread's identity (name/description/goals/aliases/repositories/packages) or any existing thread. If "${slug}" is a separate project, consider creating a planned Thread for it (\`thread.set\` with \`status: "planned"\`) and keeping this thread's body focused.`,
  });
}

function buildCoherenceWarnings(
  activeIdentity: ThreadIdentitySummary,
  contentSlugs: Set<string>,
  ctx: ProminenceContext,
  otherIdentities: Map<string, ThreadIdentitySummary>,
): ThreadCoherenceWarning[] {
  const warnings: ThreadCoherenceWarning[] = [];
  const knownSeen = new Set<string>();
  const unknownSeen = new Set<string>();

  for (const slug of contentSlugs) {
    if (activeIdentity.slugs.has(slug) || !isProminent(slug, ctx)) {
      continue;
    }

    const other = otherIdentities.get(slug);
    if (other !== undefined) {
      addKnownThreadWarning(warnings, knownSeen, slug, other);
      continue;
    }

    addUnknownSlugWarning(warnings, unknownSeen, slug);
  }

  return warnings;
}

/**
 * Detect when new thread content looks like it belongs to a different thread.
 * Returns advisory warnings — the tool layer decides whether to block on them.
 *
 * Two signals:
 * - **known-thread-mention**: content prominently references a slug that matches
 *   another vault thread's identity (its id, name, aliases, repos, packages, etc.).
 * - **unknown-slug-mention**: content prominently references a kebab slug that
 *   doesn't appear in this thread's identity *or* any other vault thread —
 *   suggesting a new project that should likely be its own (planned) Thread.
 *
 * "Prominent" = appears in a markdown heading, in the opening 200 chars, or 3+ times.
 */
export function assessThreadCoherence(
  activeThread: VaultNote,
  newContent: string,
  otherThreads: VaultNote[],
): ThreadCoherenceWarning[] {
  if (newContent.trim().length === 0) {
    return [];
  }

  const activeIdentity = summarizeIdentity(activeThread);
  if (activeIdentity === null) {
    return [];
  }

  const ctx = buildProminenceContext(newContent);
  const contentSlugs = new Set(lowercaseKebabSlugs(newContent));
  if (contentSlugs.size === 0) {
    return [];
  }

  const otherIdentities = buildOtherIdentityIndex(activeIdentity.threadId, otherThreads);
  return buildCoherenceWarnings(activeIdentity, contentSlugs, ctx, otherIdentities);
}

export function formatCoherenceWarnings(warnings: ThreadCoherenceWarning[]): string {
  return [
    'Coherence warnings (write skipped):',
    ...warnings.map((w) => `- [${w.kind}] ${w.message}`),
    '',
    'If this content is intentional, re-issue with `force: true` to override.',
  ].join('\n');
}
