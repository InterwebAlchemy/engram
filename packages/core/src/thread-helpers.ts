import * as path from 'node:path';
import { normalizeRemoteUrl } from './git-remote.js';
import { ThreadStatus } from './types.js';
import type { NoteFrontmatter, ThreadFields } from './types.js';
import { expandHome, readNonEmptyString, readStringArray } from './memory-helpers.js';
import type { VaultNote } from './vault.js';

const ACTIVE_THREAD_STATUS_RANK = 3;
const PAUSED_THREAD_STATUS_RANK = 2;
const PLANNED_THREAD_STATUS_RANK = 1;

export interface ThreadMatch {
  thread: VaultNote;
  pathScore: number | null;
  remoteMatched: boolean;
  packageMatched: boolean;
  lastActive: number;
  statusRank: number;
}

interface RankedThreadMatch {
  thread: VaultNote;
  score: number;
  lastActive: number;
  statusRank: number;
}

function threadStatusRank(status: unknown): number {
  if (status === ThreadStatus.Active) {
    return ACTIVE_THREAD_STATUS_RANK;
  }
  if (status === ThreadStatus.Paused) {
    return PAUSED_THREAD_STATUS_RANK;
  }
  if (status === ThreadStatus.Planned) {
    return PLANNED_THREAD_STATUS_RANK;
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
  candidateLastActive: number,
): boolean {
  if (current === null) {
    return true;
  }
  if (candidateStatusRank !== current.statusRank) {
    return candidateStatusRank > current.statusRank;
  }
  if (candidateScore !== current.score) {
    return candidateScore > current.score;
  }
  return candidateLastActive > current.lastActive;
}

function parseLastActive(value: unknown): number {
  if (typeof value !== 'string') {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function packageMatch(thread: VaultNote, packageNames: string[] | undefined): boolean {
  if (packageNames === undefined || packageNames.length === 0) {
    return false;
  }
  const stored = readStringArray(thread.frontmatter.packages);
  if (stored.length === 0) {
    return false;
  }
  const storedSet = new Set(stored);
  return packageNames.some((name) => storedSet.has(name));
}

function remoteMatch(thread: VaultNote, normalizedRemote?: string): boolean {
  if (normalizedRemote === undefined || normalizedRemote.length === 0) {
    return false;
  }

  return readStringArray(thread.frontmatter.repositories).some(
    (repository) => normalizeRemoteUrl(repository) === normalizedRemote,
  );
}

export interface ThreadResolveHints {
  gitRemote?: string;
  packageNames?: string[];
}

export function rankThreadMatches(
  threads: VaultNote[],
  cwd: string,
  hints: ThreadResolveHints = {},
): ThreadMatch[] {
  const { gitRemote, packageNames } = hints;
  const normalizedRemote = gitRemote === undefined ? undefined : normalizeRemoteUrl(gitRemote);
  const matches: ThreadMatch[] = [];
  for (const thread of threads) {
    const pathScore = bestPathScore(cwd, readStringArray(thread.frontmatter.paths));
    const remoteMatched = remoteMatch(thread, normalizedRemote);
    const packageMatched = packageMatch(thread, packageNames);
    if (pathScore === null && !remoteMatched && !packageMatched) {
      continue;
    }
    matches.push({
      thread,
      pathScore,
      remoteMatched,
      packageMatched,
      lastActive: parseLastActive(thread.frontmatter.last_active),
      statusRank: threadStatusRank(thread.frontmatter.status),
    });
  }
  return matches;
}

export function pickBestThreadMatch(
  threads: VaultNote[],
  cwd: string,
  hints: ThreadResolveHints = {},
): VaultNote | null {
  let currentBest: RankedThreadMatch | null = null;
  for (const match of rankThreadMatches(threads, cwd, hints)) {
    const score = scoreForMatch(match);
    if (score > 0 && isBetterMatch(currentBest, match.statusRank, score, match.lastActive)) {
      currentBest = { thread: match.thread, score, lastActive: match.lastActive, statusRank: match.statusRank };
    }
  }
  return currentBest?.thread ?? null;
}

const REMOTE_MATCH_SCORE = 2;
const PACKAGE_MATCH_SCORE = 1;

function scoreForMatch(match: ThreadMatch): number {
  if (match.pathScore !== null) {
    return match.pathScore;
  }
  return (match.remoteMatched ? REMOTE_MATCH_SCORE : 0) + (match.packageMatched ? PACKAGE_MATCH_SCORE : 0);
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

function readCreated(existing: VaultNote | null): string | undefined {
  if (existing === null) {
    return undefined;
  }

  return readNonEmptyString(existing.frontmatter.created) ?? undefined;
}

function readPlannedAt(existing: VaultNote | null): string | undefined {
  if (existing === null) {
    return undefined;
  }

  return readNonEmptyString(existing.frontmatter.planned_at) ?? undefined;
}

function readActivatedAt(existing: VaultNote | null): string | undefined {
  if (existing === null) {
    return undefined;
  }

  return readNonEmptyString(existing.frontmatter.activated_at) ?? undefined;
}

function resolvePlannedAt(
  status: ThreadStatus,
  existingPlannedAt: string | undefined,
  now: string,
): string | undefined {
  if (status !== ThreadStatus.Planned) {
    return existingPlannedAt;
  }

  return existingPlannedAt ?? now;
}

export function buildThreadFrontmatter(
  threadId: string,
  existing: VaultNote | null,
  fields: ThreadFields,
): NoteFrontmatter {
  const now = new Date().toISOString();
  const {
    name,
    status,
    tags,
    description,
    goals,
    paths,
    repositories,
    packages,
    aliases,
    superseded_by: supersededBy,
    related_threads: relatedThreads,
  } = fields;
  const resolvedStatus = status ?? ThreadStatus.Active;
  const created = readCreated(existing) ?? now;
  const existingPlannedAt = readPlannedAt(existing);
  const existingActivatedAt = readActivatedAt(existing);
  const plannedAt = resolvePlannedAt(resolvedStatus, existingPlannedAt, now);

  return {
    type: 'thread',
    created,
    updated: now,
    tags: tags ?? ['engram/thread', `engram/thread/${threadId}`],
    thread_id: threadId,
    name: name ?? threadId,
    status: resolvedStatus,
    ...definedEntries({
      description,
      goals,
      paths,
      repositories,
      packages,
      aliases,
      superseded_by: supersededBy,
      related_threads: relatedThreads,
      planned_at: plannedAt,
      activated_at: existingActivatedAt,
    }),
  };
}

function definedEntries(updates: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(updates).filter(([, value]) => value !== undefined),
  );
}
