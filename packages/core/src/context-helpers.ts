import { MemoryState } from './types.js';
import type { MemoryFilters, NoteFrontmatter } from './types.js';
import type { ContextBuilder } from './context.js';
import type { ScoredNote, SearchProvider } from './scoring.js';
import { readNonEmptyString, readStringArray, summaryOnly } from './memory-helpers.js';
import { VaultNote } from './vault.js';

type ContextPartition = 'core' | 'remembered' | 'default' | 'cross-thread' | 'skip';

function classifyContextNote(note: VaultNote, threadId: string | undefined): ContextPartition {
  const {
    frontmatter: {
      memory_state: state,
      thread: noteThread,
    },
  } = note;
  if (state === MemoryState.Core) {
    return 'core';
  }
  const isCrossThread =
    threadId !== undefined && typeof noteThread === 'string' && noteThread !== threadId;
  if (isCrossThread) {
    return state === MemoryState.Remembered || state === MemoryState.Default
      ? 'cross-thread'
      : 'skip';
  }
  if (state === MemoryState.Remembered) {
    return 'remembered';
  }
  if (state === MemoryState.Default) {
    return 'default';
  }
  return 'skip';
}

export function partitionContextNotes(
  notes: VaultNote[],
  soulPath: string,
  threadId?: string,
): {
  coreNotes: VaultNote[];
  rememberedNotes: VaultNote[];
  defaultNotes: VaultNote[];
  crossThreadNotes: VaultNote[];
} {
  const coreNotes: VaultNote[] = [];
  const rememberedNotes: VaultNote[] = [];
  const defaultNotes: VaultNote[] = [];
  const crossThreadNotes: VaultNote[] = [];

  for (const note of notes) {
    if (note.path === soulPath) {
      continue;
    }

    switch (classifyContextNote(note, threadId)) {
      case 'core':
        coreNotes.push(note);
        break;
      case 'remembered':
        rememberedNotes.push(note);
        break;
      case 'default':
        defaultNotes.push(note);
        break;
      case 'cross-thread':
        crossThreadNotes.push(note);
        break;
      case 'skip':
        break;
    }
  }

  return {
    coreNotes,
    rememberedNotes,
    defaultNotes,
    crossThreadNotes,
  };
}

export function addCoreContextSections(
  builder: ContextBuilder,
  coreNotes: VaultNote[],
  contextLabelFor: (note: VaultNote) => string,
  options: {
    corePriority: number;
    coreSummaryTokenThreshold: number;
  },
): void {
  for (const note of coreNotes) {
    const coreSummary = summaryOnly(note);
    const body = coreSummary !== null && builder.estimateTokens(note.content) > options.coreSummaryTokenThreshold
      ? coreSummary
      : note.content;
    builder.addSection(contextLabelFor(note), body, options.corePriority);
  }
}

export function addQueryContextSections(
  builder: ContextBuilder,
  options: {
    query: string;
    rememberedNotes: VaultNote[];
    defaultNotes: VaultNote[];
    searchProvider: SearchProvider;
    contextLabelFor: (note: VaultNote) => string;
    rememberedPriority: number;
    defaultPriorityBase: number;
    defaultPriorityRange: number;
    fallbackRememberedPriority: number;
  },
): void {
  const allCandidates = [...options.rememberedNotes, ...options.defaultNotes];
  const scored = options.searchProvider.rank(options.query, allCandidates);
  const scoredPaths = new Set(scored.map(({ note }) => note.path));

  for (const { note, score } of scored) {
    const body = summaryOnly(note);
    if (body === null) {
      continue;
    }

    const priority = note.frontmatter.memory_state === MemoryState.Remembered
      ? options.rememberedPriority
      : options.defaultPriorityBase + Math.round(score * options.defaultPriorityRange);
    builder.addSection(options.contextLabelFor(note), body, priority);
  }

  for (const note of options.rememberedNotes) {
    if (scoredPaths.has(note.path)) {
      continue;
    }

    const body = summaryOnly(note);
    if (body === null) {
      continue;
    }

    builder.addSection(options.contextLabelFor(note), body, options.fallbackRememberedPriority);
  }
}

export interface RelatedThreadCandidate {
  threadId: string;
  /** Number of cross-thread memory notes that ranked against the query. Zero when only thread-text matched. */
  memoryHitCount: number;
  /** Summary text of the top-scoring memory hit, when one exists. */
  topMemorySummary: string | null;
  /** True when the thread doc itself (name/description/goals/todos) matched the query. */
  threadTextMatched: boolean;
  /** Best score across all signals; used for ordering. */
  topScore: number;
}

export interface AggregateCrossThreadCandidatesOptions {
  query: string;
  crossThreadNotes: VaultNote[];
  /** All threads excluding the active one. */
  otherThreads: VaultNote[];
  searchProvider: SearchProvider;
  maxThreads: number;
}

/**
 * Rank cross-thread candidate notes plus thread documents against the query and
 * aggregate hits by thread. Returns up to `maxThreads` candidates ordered by
 * descending top score. Threads with no hits are omitted.
 */
export function aggregateCrossThreadCandidates(
  options: AggregateCrossThreadCandidatesOptions,
): RelatedThreadCandidate[] {
  const memoryByThread = groupMemoryHitsByThread(
    options.query,
    options.crossThreadNotes,
    options.searchProvider,
  );
  const threadTextScores = scoreThreadDocs(
    options.query,
    options.otherThreads,
    options.searchProvider,
  );

  const threadIds = new Set<string>([
    ...memoryByThread.keys(),
    ...threadTextScores.keys(),
  ]);

  const candidates: RelatedThreadCandidate[] = [];
  for (const threadId of threadIds) {
    const memoryHits = memoryByThread.get(threadId) ?? [];
    const threadTextScore = threadTextScores.get(threadId);
    const memoryDigest = digestTopMemoryHit(memoryHits);
    const topScore = Math.max(memoryDigest.score, threadTextScore ?? 0);

    candidates.push({
      threadId,
      memoryHitCount: memoryHits.length,
      topMemorySummary: memoryDigest.summary,
      threadTextMatched: threadTextScore !== undefined,
      topScore,
    });
  }

  candidates.sort((a, b) => b.topScore - a.topScore);
  return candidates.slice(0, options.maxThreads);
}

function digestTopMemoryHit(memoryHits: ScoredNote[]): { score: number; summary: string | null } {
  if (memoryHits.length === 0) {
    return { score: 0, summary: null };
  }
  const [topHit] = memoryHits;
  return { score: topHit.score, summary: summaryOnly(topHit.note) };
}

function groupMemoryHitsByThread(
  query: string,
  crossThreadNotes: VaultNote[],
  searchProvider: SearchProvider,
): Map<string, ScoredNote[]> {
  const grouped = new Map<string, ScoredNote[]>();
  if (crossThreadNotes.length === 0) {
    return grouped;
  }
  for (const hit of searchProvider.rank(query, crossThreadNotes)) {
    const noteThread = readNonEmptyString(hit.note.frontmatter.thread);
    if (noteThread === null) {
      continue;
    }
    const bucket = grouped.get(noteThread) ?? [];
    bucket.push(hit);
    grouped.set(noteThread, bucket);
  }
  return grouped;
}

function scoreThreadDocs(
  query: string,
  otherThreads: VaultNote[],
  searchProvider: SearchProvider,
): Map<string, number> {
  const scores = new Map<string, number>();
  if (otherThreads.length === 0) {
    return scores;
  }
  const searchable = otherThreads
    .map((thread): { id: string; note: VaultNote } | null => {
      const id = readNonEmptyString(thread.frontmatter.thread_id);
      return id === null ? null : { id, note: buildSearchableThreadNote(thread) };
    })
    .filter((entry): entry is { id: string; note: VaultNote } => entry !== null);

  const idByPath = new Map(searchable.map(({ id, note }) => [note.path, id]));
  for (const hit of searchProvider.rank(query, searchable.map(({ note }) => note))) {
    const id = idByPath.get(hit.note.path);
    if (id !== undefined) {
      scores.set(id, hit.score);
    }
  }
  return scores;
}

function buildSearchableThreadNote(thread: VaultNote): VaultNote {
  const name = readNonEmptyString(thread.frontmatter.name) ?? '';
  const description = readNonEmptyString(thread.frontmatter.description) ?? '';
  const goals = readStringArray(thread.frontmatter.goals);
  const summaryParts = [name, description];
  if (goals.length > 0) {
    summaryParts.push(`Goals: ${goals.join('. ')}`);
  }
  const summary = summaryParts.filter((part) => part.length > 0).join('. ');
  const frontmatter: NoteFrontmatter = {
    ...thread.frontmatter,
    summary: summary.length > 0 ? summary : undefined,
  };
  return new VaultNote(thread.path, frontmatter, thread.content);
}

/**
 * Format a list of related-thread candidates into a single context section body.
 * `threadNames` provides display names keyed by thread ID; missing entries fall
 * back to the bare ID.
 */
export function formatRelatedThreadsSection(
  candidates: RelatedThreadCandidate[],
  threadNames: Map<string, string>,
): string {
  const lines = ['Possibly related threads (cross-thread matches for your query):'];
  for (const candidate of candidates) {
    const name = threadNames.get(candidate.threadId);
    const label = name === undefined || name === candidate.threadId
      ? candidate.threadId
      : `${candidate.threadId} (${name})`;
    lines.push(`- ${label} — ${describeCandidateMatch(candidate)}`);
  }
  return lines.join('\n');
}

function describeCandidateMatch(candidate: RelatedThreadCandidate): string {
  const parts: string[] = [];
  if (candidate.memoryHitCount > 0) {
    parts.push(candidate.memoryHitCount === 1 ? '1 memory match' : `${candidate.memoryHitCount} memory matches`);
  }
  if (candidate.threadTextMatched) {
    parts.push('thread text match');
  }
  const reason = parts.length > 0 ? parts.join(' + ') : 'match';
  if (candidate.topMemorySummary === null) {
    return reason;
  }
  return `${reason}; top: "${truncateForRelatedThreads(candidate.topMemorySummary)}"`;
}

const RELATED_THREADS_SUMMARY_PREVIEW = 100;

function truncateForRelatedThreads(text: string): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  if (collapsed.length <= RELATED_THREADS_SUMMARY_PREVIEW) {
    return collapsed;
  }
  return `${collapsed.slice(0, RELATED_THREADS_SUMMARY_PREVIEW - 1).trimEnd()}…`;
}

export function addRememberedContextSections(
  builder: ContextBuilder,
  rememberedNotes: VaultNote[],
  contextLabelFor: (note: VaultNote) => string,
  rememberedPriority: number,
): void {
  for (const note of rememberedNotes) {
    const body = summaryOnly(note);
    if (body === null) {
      continue;
    }

    builder.addSection(contextLabelFor(note), body, rememberedPriority);
  }
}

function buildFilterPredicates(
  filters: MemoryFilters,
): Array<(note: VaultNote) => boolean> {
  const predicates: Array<(note: VaultNote) => boolean> = [];

  if (filters.type !== undefined) {
    predicates.push((note) => readNonEmptyString(note.frontmatter.type) === filters.type);
  }
  if (filters.state !== undefined) {
    predicates.push((note) => note.frontmatter.memory_state === filters.state);
  }
  if (Array.isArray(filters.tags) && filters.tags.length > 0) {
    const { tags } = filters;
    predicates.push((note) => {
      const noteTags = readStringArray(note.frontmatter.tags);
      return tags.some((tag) => noteTags.includes(tag));
    });
  }
  if (filters.since !== undefined) {
    const { since } = filters;
    predicates.push((note) => new Date(note.frontmatter.created) >= since);
  }
  if (filters.bootstrap_state !== undefined) {
    predicates.push((note) => note.frontmatter.bootstrap_state === filters.bootstrap_state);
  }
  if (filters.agent !== undefined) {
    predicates.push((note) => note.frontmatter.agent === filters.agent);
  }
  if (filters.platform !== undefined) {
    predicates.push((note) => note.frontmatter.platform === filters.platform);
  }
  if (filters.thread !== undefined) {
    predicates.push((note) => note.frontmatter.thread === filters.thread);
  }

  return predicates;
}

export function applyMemoryFilters(notes: VaultNote[], filters?: MemoryFilters): VaultNote[] {
  if (filters === undefined) {
    return notes;
  }

  const predicates = buildFilterPredicates(filters);
  const filtered = notes.filter((note) => predicates.every((predicate) => predicate(note)));
  return filters.limit === undefined ? filtered : filtered.slice(0, filters.limit);
}
