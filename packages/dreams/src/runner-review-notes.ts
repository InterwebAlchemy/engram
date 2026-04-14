import {
  MemoryState,
  type MemoryManager,
  type VaultNote,
} from '@interwebalchemy/engram-core';
import {
  readFrontmatterString,
  readStringArray,
} from './analyzer-utils';
import type {
  DreamsReport,
  DreamsReviewNote,
} from './types';

const THREAD_REVIEW_LIMIT = 5;

export async function loadReviewNotes(
  manager: MemoryManager,
  report: DreamsReport,
): Promise<DreamsReviewNote[]> {
  const notePaths = collectReviewNotePaths(report);
  const threadIds = collectReviewThreadIds(report);

  const [notes, threads] = await Promise.all([
    Promise.all(notePaths.map(async (notePath) => await readNoteSafely(manager, notePath))),
    Promise.all(threadIds.map(async (threadId) => await readThreadSafely(manager, threadId))),
  ]);

  return [
    ...notes
      .filter((note): note is VaultNote => note !== null)
      .map((note) => buildMemoryReviewNote(note)),
    ...threads
      .filter((thread): thread is VaultNote => thread !== null)
      .map((thread) => buildThreadReviewNote(thread)),
    ...report.scratchThreadCandidates.map((candidate) => ({
      kind: 'scratch' as const,
      path: `.scratch#${candidate.sessionId}`,
      type: 'scratch',
      state: candidate.isCompacted ? 'compacted' : 'active',
      summary: candidate.summary,
      content: candidate.summary,
      sessionId: candidate.sessionId,
      threadId: candidate.candidateThreadId ?? undefined,
      reason: candidate.reason,
      newestEntry: candidate.newestEntry,
      entryCount: candidate.entryCount,
    })),
  ];
}

function collectReviewNotePaths(report: DreamsReport): string[] {
  const paths = new Set<string>();

  addStatePaths(paths, report.stateDistribution.memoriesByState.core);
  addStatePaths(paths, report.stateDistribution.memoriesByState.remembered);
  addStatePaths(paths, report.stateDistribution.memoriesByState.default);

  for (const candidate of report.mergeCandidates) {
    for (const candidatePath of candidate.paths) {
      paths.add(candidatePath);
    }
  }

  for (const gap of report.threadCoverageGaps) {
    paths.add(gap.path);
  }

  for (const issue of report.dataQualityIssues) {
    paths.add(issue.path);
  }

  return [...paths];
}

function collectReviewThreadIds(report: DreamsReport): string[] {
  const threadIds = new Set<string>();

  for (const candidate of report.scratchThreadCandidates) {
    if (candidate.candidateThreadId !== null) {
      threadIds.add(candidate.candidateThreadId);
    }
  }

  for (const threadId of report.threadHealth.oversizedThreads) {
    threadIds.add(threadId);
  }

  for (const threadId of report.threadHealth.staleThreads) {
    threadIds.add(threadId);
  }

  for (const thread of report.threadHealth.threads) {
    if (thread.status !== 'closed' && threadIds.size < THREAD_REVIEW_LIMIT) {
      threadIds.add(thread.threadId);
    }
  }

  return [...threadIds];
}

function addStatePaths(
  paths: Set<string>,
  entries: DreamsReport['stateDistribution']['memoriesByState'][string],
): void {
  for (const entry of entries) {
    paths.add(entry.path);
  }
}

async function readNoteSafely(
  manager: MemoryManager,
  notePath: string,
): Promise<VaultNote | null> {
  return await manager.read(notePath).catch(() => null);
}

async function readThreadSafely(
  manager: MemoryManager,
  threadId: string,
): Promise<VaultNote | null> {
  return await manager.getThread(threadId).catch(() => null);
}

function buildMemoryReviewNote(note: VaultNote): DreamsReviewNote {
  return {
    kind: 'memory',
    path: note.path,
    type: note.frontmatter.type,
    state: readOptionalString(note.frontmatter.memory_state) ?? MemoryState.Default,
    summary: readOptionalString(note.frontmatter.summary),
    content: note.content,
  };
}

function buildThreadReviewNote(thread: VaultNote): DreamsReviewNote {
  return {
    kind: 'thread',
    path: thread.path,
    type: 'thread',
    state: readOptionalString(thread.frontmatter.status) ?? 'active',
    content: thread.content,
    threadId: readFrontmatterString(thread.frontmatter.thread_id),
    description: readOptionalString(thread.frontmatter.description),
    goals: readOptionalStringArray(thread.frontmatter.goals),
    relatedThreads: readOptionalStringArray(thread.frontmatter.related_threads),
    paths: readOptionalStringArray(thread.frontmatter.paths),
  };
}

function readOptionalString(value: unknown): string | undefined {
  const text = readFrontmatterString(value);
  return text.length > 0 ? text : undefined;
}

function readOptionalStringArray(value: unknown): string[] | undefined {
  const items = readStringArray(value);
  return items.length > 0 ? items : undefined;
}
