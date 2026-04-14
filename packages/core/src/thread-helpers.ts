import * as path from 'node:path';
import { ThreadStatus } from './types';
import type { NoteFrontmatter, ThreadFields } from './types';
import { expandHome, readNonEmptyString, readStringArray } from './memory-helpers';
import type { VaultNote } from './vault';

const ACTIVE_THREAD_STATUS_RANK = 2;
const PAUSED_THREAD_STATUS_RANK = 1;
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

function remoteMatch(thread: VaultNote, gitRemote?: string): boolean {
  if (gitRemote === undefined) {
    return false;
  }

  return readStringArray(thread.frontmatter.repositories).some(
    (repository) => repository === gitRemote,
  );
}

export function pickBestThreadMatch(
  threads: VaultNote[],
  cwd: string,
  gitRemote?: string,
): VaultNote | null {
  let currentBest: RankedThreadMatch | null = null;

  for (const thread of threads) {
    const statusRank = threadStatusRank(thread.frontmatter.status);
    const score = bestPathScore(cwd, readStringArray(thread.frontmatter.paths));
    if (score !== null && isBetterMatch(currentBest, statusRank, score)) {
      currentBest = { thread, score, statusRank };
      continue;
    }

    if (remoteMatch(thread, gitRemote) && isBetterMatch(currentBest, statusRank, 0)) {
      currentBest = { thread, score: 0, statusRank };
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
    related_threads: relatedThreads,
  } = fields;

  const frontmatter: NoteFrontmatter = {
    type: 'thread',
    created,
    updated: now,
    tags: tags ?? ['engram/thread', `engram/thread/${threadId}`],
    thread_id: threadId,
    name: name ?? threadId,
    status: status ?? ThreadStatus.Active,
  };
  if (description !== undefined) {
    frontmatter.description = description;
  }
  if (goals !== undefined) {
    frontmatter.goals = goals;
  }
  if (paths !== undefined) {
    frontmatter.paths = paths;
  }
  if (relatedThreads !== undefined) {
    frontmatter.related_threads = relatedThreads;
  }

  return frontmatter;
}
