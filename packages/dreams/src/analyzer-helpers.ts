import {
  MemoryState,
  ThreadStatus,
  type ScratchEntry,
  type VaultNote,
} from '@interwebalchemy/engram-core';
import {
  DAY_MS,
  buildThreadBody,
  detectTypeMismatch,
  getTags,
  getTextTokenSet,
  getTokenSet,
  groupScratchEntries,
  hasValidTagsField,
  intersect,
  isCompactedScratchGroup,
  jaccard,
  readFrontmatterString,
  readNoteState,
  readStringArray,
  readThreadStatus,
  readUpdatedTimestamp,
  summarizeScratchEntries,
} from './analyzer-utils.js';
import type {
  DataQualityIssue,
  MergeCandidate,
  ScratchHealth,
  ScratchThreadCandidate,
  StateDistribution,
  ThreadHealth,
  ThreadHealthEntry,
  ThreadCoverageGap,
} from './types.js';

const THREAD_CONTENT_MAX_BYTES = 1800;
const THREAD_CONTENT_MAX_LINES = 24;
const MERGE_SIMILARITY_THRESHOLD = 0.3;
const MERGE_RESULTS_LIMIT = 10;
const SCRATCH_ALIGNMENT_MAX_AGE_DAYS = 7;
const SCRATCH_ALIGNMENT_SUMMARY_LENGTH = 500;
const SCRATCH_ALIGNMENT_MIN_SIMILARITY = 0.08;
const SCRATCH_ALIGNMENT_DIRECT_MENTION_FLOOR = 0.2;
const SIMILARITY_PRECISION = 3;
const REASON_PRECISION = 2;
const PERCENT_SCALE = 100;
const PERCENT_PRECISION = 0;
const SCRATCH_THREAD_RESULTS_LIMIT = 8;
const VALID_BOOTSTRAP_STATES = new Set(['full', 'partial', 'none']);
const VALID_MEMORY_STATES = new Set<string>(Object.values(MemoryState));

export const THREAD_TAG_PREFIX = 'engram/thread/';
export const BASE_THREAD_TAG = 'engram/thread';
export const STALE_SCRATCH_SESSION_MAX_AGE_HOURS = 12;
export const STALE_THREAD_MAX_AGE_DAYS = 21;
export const DREAMS_SESSION_ID = 'dreams';

/** Bare tag -> engram/ namespace mapping for unambiguous cases. */
export const TAG_NORMALIZATION_MAP: Record<string, string> = {
  architecture: 'engram/architecture',
  bootstrap: 'engram/bootstrap',
  'bootstrap-sequence': 'engram/bootstrap',
  bootstrapping: 'engram/bootstrap',
  dreams: 'engram/dreams',
  identity: 'engram/identity',
  project: 'engram/project',
  roadmap: 'engram/roadmap',
  scratch: 'engram/scratch',
  snapshot: 'engram/snapshot',
  threads: 'engram/threads',
  'engram-feature': 'engram/feature',
  'harness-detection': 'engram/harness-detection',
  'harness-negotiation': 'engram/harness-negotiation',
  'open-question': 'engram/open-question',
  'session-log': 'engram/session-log',
};

export function emptyStateDistribution(): StateDistribution {
  return {
    counts: {
      [MemoryState.Core]: 0,
      [MemoryState.Remembered]: 0,
      [MemoryState.Default]: 0,
      [MemoryState.Forgotten]: 0,
    },
    total: 0,
    memoriesByState: {
      [MemoryState.Core]: [],
      [MemoryState.Remembered]: [],
      [MemoryState.Default]: [],
      [MemoryState.Forgotten]: [],
    },
  };
}

export function emptyScratchHealth(): ScratchHealth {
  return {
    entryCount: 0,
    totalSizeBytes: 0,
    sessions: [],
    staleSessions: [],
  };
}

export function emptyThreadHealth(): ThreadHealth {
  return {
    totalCount: 0,
    totalSizeBytes: 0,
    countsByStatus: {
      [ThreadStatus.Active]: 0,
      [ThreadStatus.Paused]: 0,
      [ThreadStatus.Closed]: 0,
    },
    threads: [],
    oversizedThreads: [],
    staleThreads: [],
  };
}

export function analyzeStateDistribution(notes: VaultNote[]): StateDistribution {
  const distribution = emptyStateDistribution();

  for (const note of notes) {
    const state = readNoteState(note);
    if (!(state in distribution.counts)) {
      distribution.counts[state] = 0;
      distribution.memoriesByState[state] = [];
    }

    distribution.counts[state] += 1;
    distribution.memoriesByState[state].push({
      path: note.path,
      updated: readUpdatedTimestamp(note),
      hasThread: readFrontmatterString(note.frontmatter.thread).length > 0,
      hasSummary: readFrontmatterString(note.frontmatter.summary).trim().length > 0,
    });
  }

  for (const entries of Object.values(distribution.memoriesByState)) {
    entries.sort((left, right) => right.updated.localeCompare(left.updated));
  }

  const { length: total } = notes;
  distribution.total = total;
  return distribution;
}

export function analyzeThreadCoverage(notes: VaultNote[]): ThreadCoverageGap[] {
  return notes
    .map<ThreadCoverageGap | null>((note) => {
      const tags = getTags(note).filter(
        (tag) => tag.startsWith(THREAD_TAG_PREFIX) && tag !== BASE_THREAD_TAG,
      );
      const hasThreadField = readFrontmatterString(note.frontmatter.thread).length > 0;
      if (tags.length === 0 || hasThreadField) {
        return null;
      }

      const [firstTag] = tags;
      return {
        path: note.path,
        threadTags: tags,
        hasThreadField,
        suggestedThreadId: firstTag.slice(THREAD_TAG_PREFIX.length),
      };
    })
    .filter((gap): gap is ThreadCoverageGap => gap !== null);
}

export function analyzeThreadHealth(threads: VaultNote[]): ThreadHealth {
  const countsByStatus: Record<ThreadStatus, number> = {
    [ThreadStatus.Active]: 0,
    [ThreadStatus.Paused]: 0,
    [ThreadStatus.Closed]: 0,
  };

  const entries = threads.map<ThreadHealthEntry>((thread) => {
    const { content, frontmatter, path: threadPath } = thread;
    const status = readThreadStatus(frontmatter.status);
    countsByStatus[status] += 1;

    const updated = readUpdatedTimestamp(thread);
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const { length: lineCount } = content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const ageDays = updated.length > 0 ? (Date.now() - new Date(updated).getTime()) / DAY_MS : 0;

    return {
      threadId: readFrontmatterString(frontmatter.thread_id),
      path: threadPath,
      status,
      updated,
      contentBytes,
      lineCount,
      goalCount: readStringArray(frontmatter.goals).length,
      pathCount: readStringArray(frontmatter.paths).length,
      relatedThreadCount: readStringArray(frontmatter.related_threads).length,
      isOversized: contentBytes > THREAD_CONTENT_MAX_BYTES || lineCount > THREAD_CONTENT_MAX_LINES,
      isStale: status !== ThreadStatus.Closed && updated.length > 0 && ageDays > STALE_THREAD_MAX_AGE_DAYS,
    };
  });

  entries.sort((left, right) => {
    if (left.isOversized !== right.isOversized) {
      return Number(right.isOversized) - Number(left.isOversized);
    }

    if (left.isStale !== right.isStale) {
      return Number(right.isStale) - Number(left.isStale);
    }

    return right.updated.localeCompare(left.updated);
  });

  return {
    totalCount: entries.length,
    totalSizeBytes: entries.reduce((sum, entry) => sum + entry.contentBytes, 0),
    countsByStatus,
    threads: entries,
    oversizedThreads: entries.filter((entry) => entry.isOversized).map((entry) => entry.threadId),
    staleThreads: entries.filter((entry) => entry.isStale).map((entry) => entry.threadId),
  };
}

export function analyzeMergeCandidates(notes: VaultNote[]): MergeCandidate[] {
  const candidates: MergeCandidate[] = [];
  const tokenCache = new Map<string, Set<string>>();

  for (const [leftIndex, left] of notes.entries()) {
    for (const right of notes.slice(leftIndex + 1)) {
      if (left.frontmatter.type !== right.frontmatter.type) {
        continue;
      }

      const leftTokens = getTokenSet(left, tokenCache);
      const rightTokens = getTokenSet(right, tokenCache);
      if (leftTokens.size === 0 || rightTokens.size === 0) {
        continue;
      }

      const similarity = jaccard(leftTokens, rightTokens);
      if (similarity <= MERGE_SIMILARITY_THRESHOLD) {
        continue;
      }

      candidates.push({
        paths: [left.path, right.path],
        similarity: Number(similarity.toFixed(SIMILARITY_PRECISION)),
        sharedTags: intersect(getTags(left), getTags(right)),
        reason: `Same type (${left.frontmatter.type}); Jaccard similarity ${similarity.toFixed(REASON_PRECISION)} across note content.`,
      });
    }
  }

  return candidates
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, MERGE_RESULTS_LIMIT);
}

export function analyzeDataQuality(notes: VaultNote[]): DataQualityIssue[] {
  return notes
    .map((note) => {
      const issues = collectDataQualityIssues(note);
      if (issues.length === 0) {
        return null;
      }

      return { path: note.path, issues };
    })
    .filter((issue): issue is DataQualityIssue => issue !== null);
}

export function analyzeScratchHealth(entries: ScratchEntry[]): ScratchHealth {
  const sessionMap = groupScratchEntries(entries);
  const sessions = [...sessionMap.entries()]
    .map(([sessionId, group]) => buildScratchSessionHealth(sessionId, group))
    .sort((left, right) => left.newestEntry.localeCompare(right.newestEntry));

  const staleSessions = sessions
    .filter(
      (session) =>
        !session.isCompacted &&
        session.newestEntry.length > 0 &&
        Date.now() - new Date(session.newestEntry).getTime() > DAY_MS,
    )
    .map((session) => session.sessionId);

  const totalSizeBytes = entries.reduce(
    (sum, entry) => sum + Buffer.byteLength(`[${entry.sessionId} | ${entry.timestamp}] ${entry.content}\n`, 'utf8'),
    0,
  );

  return {
    entryCount: entries.length,
    totalSizeBytes,
    sessions,
    staleSessions,
  };
}

export function analyzeScratchThreadAlignment(
  entries: ScratchEntry[],
  threads: VaultNote[],
): ScratchThreadCandidate[] {
  const openThreads = threads.filter((thread) => !isClosedThread(thread));

  return [...groupScratchEntries(entries, { excludeSessionId: DREAMS_SESSION_ID }).entries()]
    .map(([sessionId, group]) => buildScratchThreadCandidate(sessionId, group, openThreads))
    .filter((candidate): candidate is ScratchThreadCandidate => candidate !== null)
    .sort((left, right) => {
      if (left.isCompacted !== right.isCompacted) {
        return Number(left.isCompacted) - Number(right.isCompacted);
      }

      if (left.similarity !== right.similarity) {
        return right.similarity - left.similarity;
      }

      return right.newestEntry.localeCompare(left.newestEntry);
    })
    .slice(0, SCRATCH_THREAD_RESULTS_LIMIT);
}

function collectDataQualityIssues(note: VaultNote): string[] {
  const issues: string[] = [];
  appendStateIssues(note, issues);
  appendTimestampIssues(note, issues);
  appendSchemaIssues(note, issues);
  appendSummaryIssue(note, issues);
  appendTypeMismatchIssue(note, issues);
  return issues;
}

function buildScratchSessionHealth(
  sessionId: string,
  group: ScratchEntry[],
): ScratchHealth['sessions'][number] {
  const sortedEntries = [...group].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const oldestEntry = sortedEntries.at(0)?.timestamp ?? '';
  const newestEntry = sortedEntries.at(-1)?.timestamp ?? '';

  return {
    sessionId,
    entryCount: sortedEntries.length,
    oldestEntry,
    newestEntry,
    isCompacted: isCompactedScratchGroup(sortedEntries),
  };
}

function buildScratchThreadCandidate(
  sessionId: string,
  group: ScratchEntry[],
  openThreads: VaultNote[],
): ScratchThreadCandidate | null {
  const sortedEntries = [...group].sort((left, right) => left.timestamp.localeCompare(right.timestamp));
  const newestEntry = sortedEntries.at(-1)?.timestamp ?? '';
  if (newestEntry.length === 0) {
    return null;
  }

  const ageMs = Date.now() - new Date(newestEntry).getTime();
  if (ageMs > SCRATCH_ALIGNMENT_MAX_AGE_DAYS * DAY_MS) {
    return null;
  }

  const scratchText = sortedEntries.map((entry) => entry.content).join('\n');
  const summary = summarizeScratchEntries(sortedEntries, SCRATCH_ALIGNMENT_SUMMARY_LENGTH);
  const match = findBestScratchThreadMatch(scratchText, openThreads);
  if (match === null || match.similarity < SCRATCH_ALIGNMENT_MIN_SIMILARITY) {
    return null;
  }

  return {
    sessionId,
    entryCount: sortedEntries.length,
    newestEntry,
    isCompacted: isCompactedScratchGroup(sortedEntries),
    candidateThreadId: match.threadId,
    similarity: Number(match.similarity.toFixed(SIMILARITY_PRECISION)),
    reason: match.reason,
    summary,
  };
}

function findBestScratchThreadMatch(
  scratchText: string,
  openThreads: VaultNote[],
): { reason: string; similarity: number; threadId: string } | null {
  const lowerScratch = scratchText.toLowerCase();
  const scratchTokens = getTextTokenSet(scratchText);
  let bestMatch: { reason: string; similarity: number; threadId: string } | null = null;

  for (const thread of openThreads) {
    const threadId = readFrontmatterString(thread.frontmatter.thread_id);
    if (threadId.length === 0) {
      continue;
    }

    const threadName = readFrontmatterString(thread.frontmatter.name);
    const similarity = jaccard(scratchTokens, getTextTokenSet(buildThreadBody(thread)));
    const directMention =
      lowerScratch.includes(threadId.toLowerCase()) ||
      (threadName.length > 0 && lowerScratch.includes(threadName.toLowerCase()));
    const adjustedSimilarity = directMention
      ? Math.max(similarity, SCRATCH_ALIGNMENT_DIRECT_MENTION_FLOOR)
      : similarity;

    if (bestMatch !== null && adjustedSimilarity <= bestMatch.similarity) {
      continue;
    }

    const threadLabel = threadName.length > 0 ? `${threadId} (${threadName})` : threadId;
    bestMatch = {
      threadId,
      similarity: adjustedSimilarity,
      reason: directMention
        ? `scratch directly references thread ${threadLabel}`
        : `scratch overlaps with thread ${threadLabel} at ${(adjustedSimilarity * PERCENT_SCALE).toFixed(PERCENT_PRECISION)}% similarity`,
    };
  }

  return bestMatch;
}

function appendStateIssues(note: VaultNote, issues: string[]): void {
  const state = readFrontmatterString(note.frontmatter.memory_state);
  if (state.length > 0 && !VALID_MEMORY_STATES.has(state)) {
    issues.push(`invalid memory_state "${state}"`);
  }
}

function appendTimestampIssues(note: VaultNote, issues: string[]): void {
  if (readFrontmatterString(note.frontmatter.created).length === 0) {
    issues.push('missing created timestamp');
  }

  if (readFrontmatterString(note.frontmatter.updated).length === 0) {
    issues.push('missing updated timestamp');
  }
}

function appendSchemaIssues(note: VaultNote, issues: string[]): void {
  const { frontmatter } = note;
  const { bootstrap_state: bootstrapState, thread } = frontmatter;
  if (
    bootstrapState !== undefined &&
    (typeof bootstrapState !== 'string' || !VALID_BOOTSTRAP_STATES.has(bootstrapState))
  ) {
    issues.push(`invalid bootstrap_state "${formatUnknownValue(bootstrapState)}"`);
  }

  if (thread !== undefined && typeof thread !== 'string') {
    issues.push('thread field is not a string');
  }

  if (!hasValidTagsField(note)) {
    issues.push('tags field is neither array nor string');
  }
}

function appendSummaryIssue(note: VaultNote, issues: string[]): void {
  const state = readFrontmatterString(note.frontmatter.memory_state);
  const summary = readFrontmatterString(note.frontmatter.summary).trim();
  if (state !== 'core' && summary.length === 0) {
    issues.push('missing summary');
  }
}

function appendTypeMismatchIssue(note: VaultNote, issues: string[]): void {
  const typeMismatch = detectTypeMismatch(note);
  if (typeMismatch !== null) {
    issues.push(typeMismatch);
  }
}

function formatUnknownValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return `${value}`;
  }

  return 'invalid';
}

function isClosedThread(thread: VaultNote): boolean {
  return readFrontmatterString(thread.frontmatter.status) === 'closed';
}
