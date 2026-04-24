import * as path from 'node:path';
import { normalizeRemoteUrl } from './git-remote.js';
import { ThreadStatus } from './types.js';
import type { NoteFrontmatter, ThreadFields } from './types.js';
import { expandHome, readNonEmptyString, readStringArray } from './memory-helpers.js';
import type { VaultNote } from './vault.js';

const ACTIVE_THREAD_STATUS_RANK = 2;
const PAUSED_THREAD_STATUS_RANK = 1;

export interface ThreadMatch {
  thread: VaultNote;
  pathScore: number | null;
  remoteMatched: boolean;
  statusRank: number;
}

interface RankedThreadMatch {
  thread: VaultNote;
  score: number;
  statusRank: number;
}

function threadStatusRank(status: unknown): number {
  if (status === ThreadStatus.Active) {
    return ACTIVE_THREAD_STATUS_RANK;
  }
  if (status === ThreadStatus.Paused) {
    return PAUSED_THREAD_STATUS_RANK;
  }

  return 0;
}

function pathOverlapScore(cwd: string, threadPath: string): number | null {
  const resolved = path.resolve(expandHome(threadPath));
  const cwdInThread = cwd === resolved || cwd.startsWith(resolved + path.sep);
  const threadInCwd = resolved === cwd || resolved.startsWith(cwd + path.sep);
  if (!cwdInThread && !threadInCwd) {
    return null;
  }

  return cwdInThread ? resolved.length : cwd.length;
}

function bestPathScore(cwd: string, paths: string[]): number | null {
  let bestScore: number | null = null;
  for (const threadPath of paths) {
    const score = pathOverlapScore(cwd, threadPath);
    if (score === null) {
      continue;
    }

    if (bestScore === null || score > bestScore) {
      bestScore = score;
    }
  }

  return bestScore;
}

function isBetterMatch(
  current: RankedThreadMatch | null,
  candidateStatusRank: number,
  candidateScore: number,
): boolean {
  if (current === null) {
    return true;
  }
  if (candidateStatusRank > current.statusRank) {
    return true;
  }

  return candidateStatusRank === current.statusRank && candidateScore > current.score;
}

function remoteMatch(thread: VaultNote, normalizedRemote?: string): boolean {
  if (normalizedRemote === undefined || normalizedRemote.length === 0) {
    return false;
  }

  return readStringArray(thread.frontmatter.repositories).some(
    (repository) => normalizeRemoteUrl(repository) === normalizedRemote,
  );
}

export function rankThreadMatches(
  threads: VaultNote[],
  cwd: string,
  gitRemote?: string,
): ThreadMatch[] {
  const normalizedRemote = gitRemote === undefined ? undefined : normalizeRemoteUrl(gitRemote);
  const matches: ThreadMatch[] = [];
  for (const thread of threads) {
    const pathScore = bestPathScore(cwd, readStringArray(thread.frontmatter.paths));
    const remoteMatched = remoteMatch(thread, normalizedRemote);
    if (pathScore === null && !remoteMatched) {
      continue;
    }
    matches.push({
      thread,
      pathScore,
      remoteMatched,
      statusRank: threadStatusRank(thread.frontmatter.status),
    });
  }
  return matches;
}

export function pickBestThreadMatch(
  threads: VaultNote[],
  cwd: string,
  gitRemote?: string,
): VaultNote | null {
  let currentBest: RankedThreadMatch | null = null;

  for (const match of rankThreadMatches(threads, cwd, gitRemote)) {
    const score = match.pathScore ?? 0;
    if (match.pathScore !== null && isBetterMatch(currentBest, match.statusRank, score)) {
      currentBest = { thread: match.thread, score, statusRank: match.statusRank };
      continue;
    }

    if (match.remoteMatched && isBetterMatch(currentBest, match.statusRank, 0)) {
      currentBest = { thread: match.thread, score: 0, statusRank: match.statusRank };
    }
  }

  return currentBest?.thread ?? null;
}

export function resolveThreadIdOrThrow(thread: VaultNote): string {
  const threadId = readNonEmptyString(thread.frontmatter.thread_id);
  if (threadId === null) {
    throw new Error(`Resolved thread is missing thread_id: ${thread.path}`);
  }

  return threadId;
}

export function mergeUniqueStrings(...groups: string[][]): string[] {
  return [...new Set(groups.flat())];
}

export function mergeThreadDescription(
  targetDescription: string,
  sourceId: string,
  sourceDescription: string,
): string | undefined {
  if (targetDescription.length > 0 && sourceDescription.length > 0) {
    return `${targetDescription}\n\nMerged from ${sourceId}: ${sourceDescription}`;
  }
  if (targetDescription.length > 0) {
    return targetDescription;
  }
  if (sourceDescription.length > 0) {
    return sourceDescription;
  }

  return undefined;
}

export function buildThreadFrontmatter(
  threadId: string,
  existing: VaultNote | null,
  fields: ThreadFields,
): NoteFrontmatter {
  const now = new Date().toISOString();
  const created = existing === null
    ? now
    : readNonEmptyString(existing.frontmatter.created) ?? now;
  const {
    name,
    status,
    tags,
    description,
    goals,
    paths,
    repositories,
    related_threads: relatedThreads,
  } = fields;

  return {
    type: 'thread',
    created,
    updated: now,
    tags: tags ?? ['engram/thread', `engram/thread/${threadId}`],
    thread_id: threadId,
    name: name ?? threadId,
    status: status ?? ThreadStatus.Active,
    ...definedEntries({
      description,
      goals,
      paths,
      repositories,
      related_threads: relatedThreads,
    }),
  };
}

function definedEntries(updates: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );
}
