import {
  MemoryState,
  MemoryType,
  type ScratchEntry,
  type VaultNote,
  estimateTokens,
  renderBootstrapScratch,
} from '@interwebalchemy/engram-core';
import { summarizeThread } from '../../../core/src/memory-helpers';
import type {
  GlobalInboxInfo,
  ScratchInfo,
  ScratchSession,
  ThreadInfo,
} from './donut-chart-types';

const SCRATCH_PALETTE = [
  'var(--engram-scratch-1, #6c8aff)',
  'var(--engram-scratch-2, #8ad1c2)',
  'var(--engram-scratch-3, #d2a3ff)',
  'var(--engram-scratch-4, #ffb38a)',
  'var(--engram-scratch-5, #f78ca7)',
  'var(--engram-scratch-6, #a8c97f)',
];
const SCRATCH_COLOR = 'var(--engram-scratch-base, var(--color-accent))';
const THREAD_COLOR = 'var(--engram-thread, var(--color-orange))';
const GLOBAL_INBOX_COLOR = 'var(--engram-global-inbox, #7ab7cf)';
const THREAD_PALETTE = [
  'var(--engram-thread-1, #f09a6b)',
  'var(--engram-thread-2, #8ab6ff)',
  'var(--engram-thread-3, #8dd0a6)',
  'var(--engram-thread-4, #cf9cff)',
  'var(--engram-thread-5, #f0c86a)',
  'var(--engram-thread-6, #de7f9f)',
] as const;
const SESSION_LABEL_LENGTH = 8;

const STATE_ORDER = [
  MemoryState.Core,
  MemoryState.Remembered,
  MemoryState.Default,
  MemoryState.Forgotten,
] as const;
const TYPE_ORDER = [
  MemoryType.Fact,
  MemoryType.Entity,
  MemoryType.Reflection,
  'other',
] as const;
export const STATE_META = {
  [MemoryState.Core]: { color: 'var(--engram-state-core)', label: 'Core' },
  [MemoryState.Remembered]: { color: 'var(--engram-state-remembered)', label: 'Remembered' },
  [MemoryState.Default]: { color: 'var(--engram-state-default)', label: 'Default' },
  [MemoryState.Forgotten]: { color: 'var(--engram-state-forgotten)', label: 'Forgotten' },
} satisfies Record<MemoryState, { color: string; label: string }>;
export const TYPE_META: Record<string, { color: string; label: string }> = {
  [MemoryType.Fact]: { color: 'var(--engram-type-fact)', label: 'Facts' },
  [MemoryType.Entity]: { color: 'var(--engram-type-entity)', label: 'Entities' },
  [MemoryType.Reflection]: { color: 'var(--engram-type-reflection)', label: 'Reflections' },
  other: { color: 'var(--engram-type-other)', label: 'Other' },
};
export const TYPE_COLOR_BY_LABEL: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const { label, color } of Object.values(TYPE_META)) {
    map[label] = color;
  }
  return map;
})();

export interface TypeBreakdown {
  color: string;
  count: number;
  tokens: number;
  label: string;
}

export interface StateBreakdown {
  color: string;
  count: number;
  tokens: number;
  label: string;
  types: TypeBreakdown[];
}

export function buildStateBreakdown(memoryNotes: VaultNote[]): StateBreakdown[] {
  return collectBreakdown(memoryNotes, (typeCount) => typeCount);
}

export function buildTokenBreakdown(memoryNotes: VaultNote[]): StateBreakdown[] {
  return collectBreakdown(memoryNotes, (_typeCount, typeTokens) => typeTokens);
}

function collectBreakdown(
  memoryNotes: VaultNote[],
  pickValue: (count: number, tokens: number) => number,
): StateBreakdown[] {
  const counts = createStateTypeCounts();
  const tokens = createStateTypeCounts();
  for (const note of memoryNotes) {
    const state = normalizeMemoryState(note.frontmatter.memory_state);
    const type = normalizeMemoryType(note.frontmatter.type);
    counts[state][type] += 1;
    tokens[state][type] += estimateNoteTokens(note);
  }
  return STATE_ORDER.map((state) => {
    const types = TYPE_ORDER
      .map((type) => ({
        color: TYPE_META[type].color,
        count: pickValue(counts[state][type], tokens[state][type]),
        label: TYPE_META[type].label,
        tokens: tokens[state][type],
      }))
      .filter((type) => type.count > 0);
    return {
      color: STATE_META[state].color,
      count: types.reduce((sum, type) => sum + type.count, 0),
      label: STATE_META[state].label,
      tokens: types.reduce((sum, type) => sum + type.tokens, 0),
      types,
    };
  });
}

function createStateTypeCounts(): Record<MemoryState, Record<string, number>> {
  return {
    [MemoryState.Core]: createTypeCounts(),
    [MemoryState.Remembered]: createTypeCounts(),
    [MemoryState.Default]: createTypeCounts(),
    [MemoryState.Forgotten]: createTypeCounts(),
  };
}

function createTypeCounts(): Record<string, number> {
  return {
    [MemoryType.Fact]: 0,
    [MemoryType.Entity]: 0,
    [MemoryType.Reflection]: 0,
    other: 0,
  };
}

function normalizeMemoryState(value: unknown): MemoryState {
  switch (value) {
    case MemoryState.Core:
    case MemoryState.Remembered:
    case MemoryState.Forgotten:
      return value;
    case MemoryState.Default:
    default:
      return MemoryState.Default;
  }
}

function normalizeMemoryType(value: unknown): string {
  switch (value) {
    case MemoryType.Fact:
    case MemoryType.Entity:
    case MemoryType.Reflection:
      return value;
    default:
      return 'other';
  }
}

export function buildScratchInfo(entries: ScratchEntry[]): ScratchInfo {
  const { included, excluded } = renderBootstrapScratch(entries, { estimateTokens });
  const includedKeys = new Set(
    included.map(({ entry }) => scratchEntryKey(entry)),
  );
  const bootstrapTokensByEntry = new Map<string, number>();
  for (const { entry, rendered } of included) {
    bootstrapTokensByEntry.set(scratchEntryKey(entry), estimateTokens(rendered));
  }

  const sessionOrder: string[] = [];
  const sessionMap = new Map<string, {
    entryCount: number;
    tokens: number;
    bootstrapEntryCount: number;
    bootstrapTokens: number;
    lastSeenAt: string;
  }>();
  for (const entry of entries) {
    const { sessionId, timestamp, content } = entry;
    if (!sessionMap.has(sessionId)) {
      sessionOrder.push(sessionId);
      sessionMap.set(sessionId, {
        entryCount: 0,
        tokens: 0,
        bootstrapEntryCount: 0,
        bootstrapTokens: 0,
        lastSeenAt: timestamp,
      });
    }
    const info = sessionMap.get(sessionId);
    if (info === undefined) continue;
    info.entryCount += 1;
    info.tokens += estimateTokens(content);
    const key = scratchEntryKey(entry);
    if (includedKeys.has(key)) {
      info.bootstrapEntryCount += 1;
      info.bootstrapTokens += bootstrapTokensByEntry.get(key) ?? 0;
    }
    if (timestamp > info.lastSeenAt) {
      info.lastSeenAt = timestamp;
    }
  }

  const sessions: ScratchSession[] = sessionOrder.map((sessionId, index) => {
    const info = sessionMap.get(sessionId);
    return {
      color: SCRATCH_PALETTE[index % SCRATCH_PALETTE.length],
      entryCount: info?.entryCount ?? 0,
      label: shortenSessionLabel(sessionId),
      sessionId,
      tokens: info?.tokens ?? 0,
      bootstrapEntryCount: info?.bootstrapEntryCount ?? 0,
      bootstrapTokens: info?.bootstrapTokens ?? 0,
    };
  });

  const totalTokens = sessions.reduce((sum, s) => sum + s.tokens, 0);
  const bootstrapTokens = sessions.reduce((sum, s) => sum + s.bootstrapTokens, 0);
  const { length: bootstrapEntries } = included;
  const { length: excludedEntries } = excluded;
  const excludedTokens = excluded.reduce((sum, entry) => sum + estimateTokens(entry.content), 0);

  return {
    color: SCRATCH_COLOR,
    sessions,
    totalEntries: entries.length,
    totalTokens,
    bootstrapEntries,
    bootstrapTokens,
    excludedEntries,
    excludedTokens,
  };
}

export function buildGlobalInboxInfo(parts: {
  items: Array<{ content: string; created: string; path: string }>;
  summary: string | null;
}): GlobalInboxInfo {
  const { items, summary } = parts;
  const storedTokens = items.reduce((sum, item) => sum + estimateTokens(item.content), 0);

  return {
    bootstrapCount: summary === null ? 0 : 1,
    bootstrapTokens: summary === null ? 0 : estimateTokens(summary),
    color: GLOBAL_INBOX_COLOR,
    exists: items.length > 0,
    storedCount: items.length,
    storedTokens,
  };
}

export function buildThreadInfo(parts: {
  color?: string;
  inboxItems: Array<{ content: string; created: string; path: string }>;
  thread: VaultNote | null;
  threadId: string | null;
  threadInboxSummary: string | null;
}): ThreadInfo {
  const {
    color = THREAD_COLOR,
    inboxItems,
    thread,
    threadId,
    threadInboxSummary,
  } = parts;

  if (thread === null || threadId === null) {
    return {
      bootstrapCount: 0,
      bootstrapTokens: 0,
      color: THREAD_COLOR,
      label: 'Thread',
      storedCount: 0,
      storedTokens: 0,
      threadId: '',
      threadInboxIncluded: false,
      threadInboxStoredCount: 0,
      threadInboxStoredTokens: 0,
      updated: '',
    };
  }

  const summary = summarizeThread(thread);
  const bootstrapSections = [
    summary,
    threadInboxSummary,
  ].filter((section): section is string => typeof section === 'string' && section.length > 0);
  const threadInboxStoredTokens = inboxItems.reduce((sum, item) => sum + estimateTokens(item.content), 0);

  const label = typeof thread.frontmatter.name === 'string' && thread.frontmatter.name.trim().length > 0
    ? formatThreadDisplayLabel(thread.frontmatter.name)
    : formatThreadDisplayLabel(threadId);

  return {
    bootstrapCount: bootstrapSections.length,
    bootstrapTokens: bootstrapSections.reduce((sum, section) => sum + estimateTokens(section), 0),
    color,
    label,
    storedCount: 1 + inboxItems.length,
    storedTokens: estimateNoteTokens(thread) + threadInboxStoredTokens,
    threadId,
    threadInboxIncluded: threadInboxSummary !== null,
    threadInboxStoredCount: inboxItems.length,
    threadInboxStoredTokens,
    updated: typeof thread.frontmatter.updated === 'string' ? thread.frontmatter.updated : '',
  };
}

export function colorForThread(seed: number | string): string {
  const index = typeof seed === 'number'
    ? seed
    : Array.from(seed).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return THREAD_PALETTE[index % THREAD_PALETTE.length];
}

function formatThreadDisplayLabel(value: string): string {
  const trimmed = value.trim();
  const baseTitle = trimmed.split(/\s+[—–-]\s+/u, 1)[0]?.trim() ?? trimmed;
  return `Thread: ${baseTitle.length > 0 ? baseTitle : trimmed}`;
}

function scratchEntryKey(entry: ScratchEntry): string {
  return `${entry.sessionId}|${entry.timestamp}|${entry.content}`;
}

function shortenSessionLabel(sessionId: string): string {
  if (sessionId === 'dreams') {
    return 'dreams';
  }
  return sessionId.length > SESSION_LABEL_LENGTH
    ? `${sessionId.slice(0, SESSION_LABEL_LENGTH)}…`
    : sessionId;
}

export function estimateNoteTokens(note: VaultNote): number {
  return estimateTokens(note.content.trim());
}

export function estimateMemoryTokens(memoryNotes: VaultNote[]): number {
  return memoryNotes.reduce((sum, note) => sum + estimateNoteTokens(note), 0);
}
