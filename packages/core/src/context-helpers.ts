import { MemoryState } from './types.js';
import type { MemoryFilters } from './types.js';
import type { ContextBuilder } from './context.js';
import type { SearchProvider } from './scoring.js';
import { readNonEmptyString, readStringArray, summaryOnly } from './memory-helpers.js';
import type { VaultNote } from './vault.js';

export function partitionContextNotes(
  notes: VaultNote[],
  soulPath: string,
  threadId?: string,
): {
  coreNotes: VaultNote[];
  rememberedNotes: VaultNote[];
  defaultNotes: VaultNote[];
} {
  const coreNotes: VaultNote[] = [];
  const rememberedNotes: VaultNote[] = [];
  const defaultNotes: VaultNote[] = [];

  for (const note of notes) {
    if (note.path === soulPath) {
      continue;
    }

    const {
      frontmatter: {
        memory_state: state,
        thread: noteThread,
      },
    } = note;
    if (state === MemoryState.Core) {
      coreNotes.push(note);
      continue;
    }
    if (threadId !== undefined && typeof noteThread === 'string' && noteThread !== threadId) {
      continue;
    }
    if (state === MemoryState.Remembered) {
      rememberedNotes.push(note);
      continue;
    }
    if (state === MemoryState.Default) {
      defaultNotes.push(note);
    }
  }

  return {
    coreNotes,
    rememberedNotes,
    defaultNotes,
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
