import * as path from 'node:path';
import {
  MemoryState,
  ThreadStatus,
  type ScratchEntry,
  type VaultNote,
} from '@interwebalchemy/engram-core';

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const TOKEN_MIN_LENGTH = 4;
const EMPTY_STRING = '';
const COMPACTED_MARKER = '[COMPACTED]';
const MEMORY_DIRECTORY_PATTERN = /\/memory\/(?<directory>[^/]+)\//u;
const TOKEN_SPLIT_PATTERN = /[^a-z0-9]+/iu;

export const DAY_MS =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

export function readFrontmatterString(value: unknown): string {
  return typeof value === 'string' ? value : EMPTY_STRING;
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function readUpdatedTimestamp(note: VaultNote): string {
  const updated = readFrontmatterString(note.frontmatter.updated);
  return updated.length > 0 ? updated : readFrontmatterString(note.frontmatter.created);
}

export function readNoteState(note: VaultNote): string {
  const state = readFrontmatterString(note.frontmatter.memory_state);
  return state.length > 0 ? state : MemoryState.Default;
}

export function readMemoryState(value: unknown): MemoryState {
  switch (value) {
    case MemoryState.Core:
    case MemoryState.Remembered:
    case MemoryState.Default:
    case MemoryState.Forgotten:
      return value;
    default:
      return MemoryState.Default;
  }
}

export function readThreadStatus(value: unknown): ThreadStatus {
  switch (value) {
    case ThreadStatus.Planned:
    case ThreadStatus.Active:
    case ThreadStatus.Paused:
    case ThreadStatus.Closed:
      return value;
    default:
      return ThreadStatus.Active;
  }
}

export function getTags(note: VaultNote): string[] {
  const { frontmatter } = note;
  const { tags } = frontmatter;
  if (Array.isArray(tags)) {
    return tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
  }

  return [];
}

export function getTokenSet(note: VaultNote, cache: Map<string, Set<string>>): Set<string> {
  const cached = cache.get(note.path);
  if (cached !== undefined) {
    return cached;
  }

  const tokens = getTextTokenSet(note.content);
  cache.set(note.path, tokens);
  return tokens;
}

export function getTextTokenSet(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(TOKEN_SPLIT_PATTERN)
      .map((token) => token.trim())
      .filter((token) => token.length >= TOKEN_MIN_LENGTH),
  );
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  const smaller = left.size <= right.size ? left : right;
  const larger = left.size <= right.size ? right : left;
  let intersection = 0;

  for (const token of smaller) {
    if (larger.has(token)) {
      intersection += 1;
    }
  }

  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function intersect(left: string[], right: string[]): string[] {
  const rightSet = new Set(right);
  return [...new Set(left.filter((tag) => rightSet.has(tag)))];
}

export function detectTypeMismatch(note: VaultNote): string | null {
  const normalizedPath = note.path.split(path.sep).join('/');
  const match = MEMORY_DIRECTORY_PATTERN.exec(normalizedPath);
  if (match === null) {
    return null;
  }

  const directory = match.groups?.directory;
  if (directory === undefined) {
    return null;
  }

  const { frontmatter } = note;
  const { type: actualType } = frontmatter;
  const expectedDir = expectedDirectoryForType(actualType);
  if (expectedDir === undefined || expectedDir === directory) {
    return null;
  }

  return `type/path mismatch: frontmatter type "${actualType}" expects memory/${expectedDir}/ but file is in memory/${directory}/`;
}

export function groupScratchEntries(
  entries: ScratchEntry[],
  options: { excludeSessionId?: string } = {},
): Map<string, ScratchEntry[]> {
  const { excludeSessionId } = options;
  const sessionMap = new Map<string, ScratchEntry[]>();

  for (const entry of entries) {
    if (excludeSessionId !== undefined && entry.sessionId === excludeSessionId) {
      continue;
    }

    const group = sessionMap.get(entry.sessionId) ?? [];
    group.push(entry);
    sessionMap.set(entry.sessionId, group);
  }

  return sessionMap;
}

export function summarizeScratchEntries(entries: ScratchEntry[], maxLength: number): string {
  return entries.map((entry) => entry.content).join(' | ').slice(0, maxLength);
}

export function isCompactedScratchGroup(entries: ScratchEntry[]): boolean {
  return entries.some((entry) => entry.content.includes(COMPACTED_MARKER));
}

export function findOrphanedDreamStarts(entries: ScratchEntry[]): ScratchEntry[] {
  const sortedEntries = [...entries].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const openStarts: ScratchEntry[] = [];

  for (const entry of sortedEntries) {
    if (entry.content.includes('[DREAM START]')) {
      openStarts.push(entry);
      continue;
    }

    if (entry.content.includes('[DREAM END]') && openStarts.length > 0) {
      openStarts.pop();
    }
  }

  return openStarts;
}

export function buildThreadBody(thread: VaultNote): string {
  return [
    readFrontmatterString(thread.frontmatter.thread_id),
    readFrontmatterString(thread.frontmatter.name),
    readFrontmatterString(thread.frontmatter.description),
    readStringArray(thread.frontmatter.goals).join('\n'),
    thread.content,
  ].join('\n');
}

export function hasValidTagsField(note: VaultNote): boolean {
  const { frontmatter } = note;
  const { tags } = frontmatter;
  return tags === undefined || Array.isArray(tags) || typeof tags === 'string';
}

function expectedDirectoryForType(type: unknown): string | undefined {
  switch (type) {
    case 'fact':
      return 'facts';
    case 'entity':
      return 'entities';
    case 'reflection':
      return 'reflections';
    case 'skill':
      return 'skills';
    default:
      return undefined;
  }
}
