import type { FileSystemAdapter } from './adapters/types';
import { supportsProcess } from './memory-helpers';
import type {
  ScratchCompactOptions,
  ScratchDeleteOptions,
  ScratchEntry,
  ScratchReadOptions,
  ScratchPruneOptions,
} from './types';

const SCRATCH_ENTRY_PATTERN =
  /^\[(?<sessionId>[^\]]+) \| (?<timestamp>[^\]]+)\] (?<content>.+)$/u;
const NEWLINES_PATTERN = /\n+/gu;
const MIN_ENTRIES_TO_COMPACT = 2;
const SCRATCH_BOOTSTRAP_RETENTION_DAYS = 7;
const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const DREAM_COMPACTED_RETENTION_HOURS = 72;

const DREAM_START_PREFIX = '[DREAM START]';
const DREAM_NARRATIVE_PREFIX = '[DREAMING]';
const DREAM_END_PREFIX = '[DREAM END]';
const DREAM_SUMMARY_PREFIX = '[DREAM SUMMARY]';
const COMPACTED_PREFIX = '[COMPACTED]';
const EMPTY_LOG = '';

interface ParsedScratchLine {
  sessionId: string;
  timestamp: string;
  content: string;
}

interface EntrySelection {
  firstIndex: number;
  indexes: Set<number>;
}

function millisecondsFromHours(hours: number): number {
  return hours * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
}

function millisecondsFromDays(days: number): number {
  return days * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
}

function parseScratchLine(line: string): ParsedScratchLine | null {
  const match = SCRATCH_ENTRY_PATTERN.exec(line);
  if (match === null) {
    return null;
  }

  const { groups } = match;
  if (groups === undefined) {
    return null;
  }

  const { sessionId, timestamp, content } = groups;
  return { sessionId, timestamp, content };
}

function shouldKeepEntry(
  parsed: ParsedScratchLine | null,
  sessionId: string,
  cutoff: number,
): boolean {
  if (parsed?.sessionId !== sessionId) {
    return true;
  }

  return new Date(parsed.timestamp).getTime() > cutoff;
}

function shouldDeleteEntry(
  parsed: ParsedScratchLine | null,
  options: ScratchDeleteOptions,
  now: number,
): boolean {
  if (parsed === null) return false;
  if (typeof options.sessionId === 'string' && options.sessionId.length > 0 && parsed.sessionId !== options.sessionId) {
    return false;
  }
  if (typeof options.matchText === 'string' && options.matchText.length > 0 && !parsed.content.includes(options.matchText)) {
    return false;
  }
  if (typeof options.thresholdMs === 'number') {
    const cutoff = now - options.thresholdMs;
    if (new Date(parsed.timestamp).getTime() > cutoff) {
      return false;
    }
  }

  return true;
}

function entryIsVisible(
  entryTimestamp: number,
  ageCutoff: number,
  sinceTimestamp: number | null,
): boolean {
  return entryTimestamp >= ageCutoff && (sinceTimestamp === null || entryTimestamp >= sinceTimestamp);
}

function findDreamSequence(
  entries: ScratchEntry[],
  startIndex: number,
  ageCutoff: number,
  sinceTimestamp: number | null,
): {
  cursor: number;
  narrative: ScratchEntry | null;
  end: ScratchEntry | null;
} {
  let narrative: ScratchEntry | null = null;
  let end: ScratchEntry | null = null;
  let cursor = startIndex + 1;

  while (cursor < entries.length) {
    const candidate = entries.at(cursor);
    if (candidate === undefined) {
      break;
    }

    const { timestamp, content } = candidate;
    const candidateTimestamp = new Date(timestamp).getTime();
    if (entryIsVisible(candidateTimestamp, ageCutoff, sinceTimestamp)) {
      if (content.startsWith(DREAM_NARRATIVE_PREFIX)) {
        narrative = candidate;
      }
      if (content.startsWith(DREAM_END_PREFIX)) {
        end = candidate;
        break;
      }
    }

    cursor += 1;
  }

  return { cursor, narrative, end };
}

function dreamSummaryEntry(dreamEnd: ScratchEntry): ScratchEntry | null {
  const stats = dreamEnd.content
    .replace(/^\[DREAM END\]\s*/u, '')
    .split('|')[0]
    ?.trim();
  if (typeof stats !== 'string' || stats.length === 0) {
    return null;
  }

  return {
    ...dreamEnd,
    content: `${DREAM_SUMMARY_PREFIX} ${stats}`,
  };
}

function appendDreamBootstrapEntries(
  transformed: ScratchEntry[],
  entries: ScratchEntry[],
  index: number,
  options: {
    ageCutoff: number;
    sinceTimestamp: number | null;
  },
): number | null {
  const { cursor, narrative, end } = findDreamSequence(
    entries,
    index,
    options.ageCutoff,
    options.sinceTimestamp,
  );
  if (end === null) {
    return null;
  }
  if (narrative !== null) {
    transformed.push(narrative);
  }

  const summaryEntry = dreamSummaryEntry(end);
  if (summaryEntry !== null) {
    transformed.push(summaryEntry);
  }

  return cursor;
}

function selectSessionEntryIndexes(
  lines: string[],
  sessionId: string,
  cutoff: number,
): EntrySelection {
  const indexes = new Set<number>();
  let firstIndex = -1;

  lines.forEach((line, index) => {
    const parsed = parseScratchLine(line);
    if (shouldKeepEntry(parsed, sessionId, cutoff)) {
      return;
    }

    indexes.add(index);
    if (firstIndex === -1) {
      firstIndex = index;
    }
  });

  return { firstIndex, indexes };
}

export function formatScratchContent(content: string): string {
  return content.replace(NEWLINES_PATTERN, ' | ');
}

export function formatScratchLine(
  sessionId: string,
  timestamp: string,
  content: string,
): string {
  return `[${sessionId} | ${timestamp}] ${formatScratchContent(content)}`;
}

export function parseScratchLog(raw: string): ScratchEntry[] {
  return raw
    .split('\n')
    .map((line) => {
      const parsed = parseScratchLine(line);
      return parsed === null
        ? null
        : {
            sessionId: parsed.sessionId,
            timestamp: parsed.timestamp,
            content: parsed.content,
          };
    })
    .filter((entry): entry is ScratchEntry => entry !== null);
}

export function bootstrapScratchEntries(
  entries: ScratchEntry[],
  limit: number,
  since?: string,
  now = Date.now(),
): ScratchEntry[] {
  const ageCutoff = now - millisecondsFromDays(SCRATCH_BOOTSTRAP_RETENTION_DAYS);
  const compactedCutoff = now - millisecondsFromHours(DREAM_COMPACTED_RETENTION_HOURS);
  const sinceTimestamp = since === undefined ? null : new Date(since).getTime();
  const transformed: ScratchEntry[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries.at(index);
    if (entry === undefined) {
      break;
    }

    const entryTimestamp = new Date(entry.timestamp).getTime();

    if (!entryIsVisible(entryTimestamp, ageCutoff, sinceTimestamp)) {
      continue;
    }
    if (entry.content.startsWith(COMPACTED_PREFIX) && entryTimestamp < compactedCutoff) {
      continue;
    }
    if (entry.content.startsWith(DREAM_START_PREFIX)) {
      const cursor = appendDreamBootstrapEntries(
        transformed,
        entries,
        index,
        {
          ageCutoff,
          sinceTimestamp,
        },
      );
      if (cursor === null) {
        continue;
      }

      index = cursor;
      continue;
    }

    transformed.push(entry);
  }

  transformed.sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
  const limited = transformed.slice(0, limit);
  limited.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
  return limited;
}

export function compactScratchLog(
  raw: string,
  options: ScratchCompactOptions,
  timestamp = new Date().toISOString(),
): string {
  if (raw.trim().length === 0) {
    return raw;
  }

  const lines = raw.split('\n');
  const cutoff = Date.now() - options.thresholdMs;
  const selection = selectSessionEntryIndexes(lines, options.sessionId, cutoff);
  if (selection.indexes.size < MIN_ENTRIES_TO_COMPACT) {
    return raw;
  }

  const compactLine = formatScratchLine(
    options.sessionId,
    timestamp,
    `${COMPACTED_PREFIX} ${options.compactedContent}`,
  );

  return lines
    .map((line, index) => {
      if (index === selection.firstIndex) {
        return compactLine;
      }
      if (selection.indexes.has(index)) {
        return null;
      }

      return line;
    })
    .filter((line): line is string => line !== null)
    .join('\n');
}

export function pruneScratchLog(
  raw: string,
  options: ScratchPruneOptions,
): { content: string; removed: number } {
  if (raw.trim().length === 0) {
    return { content: raw, removed: 0 };
  }

  const lines = raw.split('\n');
  const cutoff = Date.now() - options.thresholdMs;
  let removed = 0;

  const kept = lines.filter((line) => {
    const parsed = parseScratchLine(line);
    if (shouldKeepEntry(parsed, options.sessionId, cutoff)) {
      return true;
    }

    removed += 1;
    return false;
  });

  return {
    content: kept.join('\n'),
    removed,
  };
}

export function deleteScratchLog(
  raw: string,
  options: ScratchDeleteOptions,
): { content: string; removed: number } {
  if (raw.trim().length === 0) return { content: raw, removed: 0 };

  const now = Date.now();
  const lines = raw.split('\n');
  let removed = 0;

  const kept = lines.filter((line) => {
    const parsed = parseScratchLine(line);
    if (!shouldDeleteEntry(parsed, options, now)) {
      return true;
    }

    removed += 1;
    return false;
  });

  return { content: kept.join('\n'), removed };
}

export async function appendScratchEntry(
  adapter: FileSystemAdapter,
  logPath: string,
  sessionId: string,
  content: string,
): Promise<void> {
  const timestamp = new Date().toISOString();
  const line = formatScratchLine(sessionId, timestamp, content);

  if (supportsProcess(adapter)) {
    await adapter.process(logPath, (existing) =>
      existing.trim().length > 0 ? `${existing.trimEnd()}\n${line}` : line,
    );
    return;
  }

  const existing = await adapter.read(logPath).catch(() => EMPTY_LOG);
  const nextContent = existing.trim().length > 0 ? `${existing.trimEnd()}\n${line}` : line;
  await adapter.write(logPath, nextContent);
}

export async function readScratchEntries(
  adapter: FileSystemAdapter,
  logPath: string,
  options: ScratchReadOptions = {},
  defaults: {
    bootstrapLimit: number;
    defaultLimit: number;
  },
): Promise<ScratchEntry[]> {
  const raw = await adapter.read(logPath).catch(() => EMPTY_LOG);
  if (raw.trim().length === 0) {
    return [];
  }

  let entries = parseScratchLog(raw);

  if (typeof options.sessionId === 'string' && options.sessionId.length > 0) {
    entries = entries.filter(({ sessionId }) => sessionId === options.sessionId);
  }

  if (options.bootstrap === true) {
    return bootstrapScratchEntries(entries, options.limit ?? defaults.bootstrapLimit, options.since);
  }

  if (typeof options.since === 'string' && options.since.length > 0) {
    const sinceTimestamp = new Date(options.since).getTime();
    entries = entries.filter((entry) => new Date(entry.timestamp).getTime() >= sinceTimestamp);
  }

  entries.sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
  entries = entries.slice(0, options.limit ?? defaults.defaultLimit);
  entries.sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());

  return entries;
}

export async function compactScratchFile(
  adapter: FileSystemAdapter,
  logPath: string,
  options: ScratchCompactOptions,
): Promise<void> {
  if (supportsProcess(adapter)) {
    const exists = await adapter.exists(logPath);
    if (!exists) {
      return;
    }

    await adapter.process(logPath, (raw) => raw.trim().length === 0 ? raw : compactScratchLog(raw, options));
    return;
  }

  const raw = await adapter.read(logPath).catch(() => EMPTY_LOG);
  if (raw.trim().length === 0) {
    return;
  }

  const compacted = compactScratchLog(raw, options);
  if (compacted !== raw) {
    await adapter.write(logPath, compacted);
  }
}

export async function pruneScratchFile(
  adapter: FileSystemAdapter,
  logPath: string,
  options: ScratchPruneOptions,
): Promise<number> {
  if (supportsProcess(adapter)) {
    const exists = await adapter.exists(logPath);
    if (!exists) {
      return 0;
    }

    let removed = 0;
    await adapter.process(logPath, (raw) => {
      const result = pruneScratchLog(raw, options);
      ({ removed } = result);
      return result.content;
    });
    return removed;
  }

  const raw = await adapter.read(logPath).catch(() => EMPTY_LOG);
  if (raw.trim().length === 0) {
    return 0;
  }

  const result = pruneScratchLog(raw, options);
  if (result.removed === 0) {
    return 0;
  }

  await adapter.write(logPath, result.content);
  return result.removed;
}

export async function deleteScratchFile(
  adapter: FileSystemAdapter,
  logPath: string,
  options: ScratchDeleteOptions,
): Promise<number> {
  if (supportsProcess(adapter)) {
    const exists = await adapter.exists(logPath);
    if (!exists) return 0;

    let removed = 0;
    await adapter.process(logPath, (raw) => {
      const result = deleteScratchLog(raw, options);
      ({ removed } = result);
      return result.content;
    });
    return removed;
  }

  const raw = await adapter.read(logPath).catch(() => EMPTY_LOG);
  if (raw.trim().length === 0) return 0;

  const result = deleteScratchLog(raw, options);
  if (result.removed === 0) return 0;
  await adapter.write(logPath, result.content);
  return result.removed;
}
