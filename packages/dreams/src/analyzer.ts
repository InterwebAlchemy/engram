import type { MemoryManager, ScratchEntry, VaultNote } from '@interwebalchemy/engram-core';
import {
  DREAMS_SESSION_ID,
  STALE_SCRATCH_SESSION_MAX_AGE_HOURS,
  TAG_NORMALIZATION_MAP,
  analyzeDataQuality,
  analyzeMergeCandidates,
  analyzeScratchHealth,
  analyzeScratchThreadAlignment,
  analyzeStateDistribution,
  analyzeThreadCoverage,
  analyzeThreadHealth,
  emptyScratchHealth,
  emptyStateDistribution,
  emptyThreadHealth,
} from './analyzer-helpers';
import {
  DAY_MS,
  findOrphanedDreamStarts,
  getTags,
  groupScratchEntries,
  isCompactedScratchGroup,
  summarizeScratchEntries,
} from './analyzer-utils';
import type {
  DataQualityIssue,
  DreamsFocus,
  DreamsReport,
  MergeCandidate,
  ScratchThreadCandidate,
  ThreadCoverageGap,
} from './types';

const HOURS_PER_DAY = 24;
const MAX_SCRATCH_READ_LIMIT = 10000;
const ZERO_THRESHOLD_MS = 0;
const AUTO_COMPACT_SUMMARY_LENGTH = 300;
const DEFAULT_FOCUS_AREAS: DreamsFocus[] = [
  'state_distribution',
  'thread_coverage',
  'thread_health',
  'merge_candidates',
  'data_quality',
  'scratch_health',
  'scratch_thread_alignment',
];

export interface PreCleanupResult {
  tagsFixed: number;
  tagsNormalized: number;
  scratchEntriesPurged: number;
  orphanedDreamStartsResolved: number;
}

interface PendingTagUpdate {
  path: string;
  tags: string[];
  tagsFixed: number;
  tagsNormalized: number;
}

type ScratchCleanupOperation =
  | {
      compactedContent: string;
      orphanedDreamStartsResolved: number;
      sessionId: string;
      scratchEntriesPurged: number;
      type: 'compact';
    }
  | {
      orphanedDreamStartsResolved: number;
      sessionId: string;
      scratchEntriesPurged: number;
      type: 'prune';
    };

type ScratchPrunableManager = MemoryManager & {
  pruneScratch: (options: { sessionId: string; thresholdMs: number }) => Promise<number>;
};

export class DreamsAnalyzer {
  constructor(private readonly manager: MemoryManager) {}

  async preCleanup(): Promise<PreCleanupResult> {
    const tagResult = await this.normalizeTags();
    const scratchResult = await this.cleanupScratchSessions();

    return {
      tagsFixed: tagResult.tagsFixed,
      tagsNormalized: tagResult.tagsNormalized,
      scratchEntriesPurged: scratchResult.scratchEntriesPurged,
      orphanedDreamStartsResolved: scratchResult.orphanedDreamStartsResolved,
    };
  }

  async analyze(focus?: DreamsFocus[]): Promise<DreamsReport> {
    const focusAreas = normalizeFocusAreas(focus);
    const notes = await this.manager.list();

    const [
      stateDistribution,
      threadCoverageGaps,
      threadHealth,
      mergeCandidates,
      dataQualityIssues,
      scratchHealth,
      scratchThreadCandidates,
    ] = await Promise.all([
      runIfIncluded(
        focusAreas,
        'state_distribution',
        () => analyzeStateDistribution(notes),
        emptyStateDistribution(),
      ),
      runIfIncluded(
        focusAreas,
        'thread_coverage',
        () => analyzeThreadCoverage(notes),
        [] as ThreadCoverageGap[],
      ),
      runIfIncluded(
        focusAreas,
        'thread_health',
        async () => analyzeThreadHealth(await this.manager.listThreads()),
        emptyThreadHealth(),
      ),
      runIfIncluded(
        focusAreas,
        'merge_candidates',
        () => analyzeMergeCandidates(notes),
        [] as MergeCandidate[],
      ),
      runIfIncluded(
        focusAreas,
        'data_quality',
        () => analyzeDataQuality(notes),
        [] as DataQualityIssue[],
      ),
      runIfIncluded(
        focusAreas,
        'scratch_health',
        async () => analyzeScratchHealth(await this.manager.readScratch({ limit: MAX_SCRATCH_READ_LIMIT })),
        emptyScratchHealth(),
      ),
      runIfIncluded(
        focusAreas,
        'scratch_thread_alignment',
        async () => {
          const [entries, threads] = await Promise.all([
            this.manager.readScratch({ limit: MAX_SCRATCH_READ_LIMIT }),
            this.manager.listThreads(),
          ]);
          return analyzeScratchThreadAlignment(entries, threads);
        },
        [] as ScratchThreadCandidate[],
      ),
    ]);

    return {
      timestamp: new Date().toISOString(),
      focusAreas,
      stateDistribution,
      threadCoverageGaps,
      threadHealth,
      mergeCandidates,
      dataQualityIssues,
      scratchHealth,
      scratchThreadCandidates,
    };
  }

  private async normalizeTags(): Promise<Pick<PreCleanupResult, 'tagsFixed' | 'tagsNormalized'>> {
    const notes = await this.manager.list();
    const updates = notes
      .map((note) => buildTagUpdate(note))
      .filter((update): update is PendingTagUpdate => update !== null);

    await Promise.all(
      updates.map(
        async (update) => await this.manager.update(update.path, undefined, { tags: update.tags }),
      ),
    );

    return {
      tagsFixed: updates.reduce((sum, update) => sum + update.tagsFixed, 0),
      tagsNormalized: updates.reduce((sum, update) => sum + update.tagsNormalized, 0),
    };
  }

  private async cleanupScratchSessions(): Promise<Pick<PreCleanupResult, 'scratchEntriesPurged' | 'orphanedDreamStartsResolved'>> {
    const entries = await this.manager.readScratch({ limit: MAX_SCRATCH_READ_LIMIT });
    const sessionMap = groupScratchEntries(entries);
    const operations = buildScratchCleanupOperations(sessionMap);

    const results = await Promise.all(
      operations.map(async (operation) => await this.applyScratchCleanupOperation(operation)),
    );

    return {
      scratchEntriesPurged: results.reduce((sum, result) => sum + result.scratchEntriesPurged, 0),
      orphanedDreamStartsResolved: results.reduce(
        (sum, result) => sum + result.orphanedDreamStartsResolved,
        0,
      ),
    };
  }

  private async applyScratchCleanupOperation(
    operation: ScratchCleanupOperation,
  ): Promise<Pick<PreCleanupResult, 'scratchEntriesPurged' | 'orphanedDreamStartsResolved'>> {
    if (operation.type === 'prune') {
      const removed = await this.pruneScratch(operation.sessionId, ZERO_THRESHOLD_MS);
      return {
        scratchEntriesPurged: removed,
        orphanedDreamStartsResolved: operation.orphanedDreamStartsResolved,
      };
    }

    await this.manager.compactScratch({
      sessionId: operation.sessionId,
      thresholdMs: ZERO_THRESHOLD_MS,
      compactedContent: operation.compactedContent,
    });

    return {
      scratchEntriesPurged: operation.scratchEntriesPurged,
      orphanedDreamStartsResolved: operation.orphanedDreamStartsResolved,
    };
  }

  private async pruneScratch(sessionId: string, thresholdMs: number): Promise<number> {
    return await (this.manager as ScratchPrunableManager).pruneScratch({ sessionId, thresholdMs });
  }
}

function normalizeFocusAreas(focus?: DreamsFocus[]): DreamsFocus[] {
  return focus !== undefined && focus.length > 0
    ? [...new Set(focus)]
    : DEFAULT_FOCUS_AREAS;
}

async function runIfIncluded<T>(
  focusAreas: DreamsFocus[],
  focus: DreamsFocus,
  fn: () => T | Promise<T>,
  fallback: T,
): Promise<T> {
  if (!focusAreas.includes(focus)) {
    return fallback;
  }

  return await Promise.resolve(fn());
}

function buildTagUpdate(note: VaultNote): PendingTagUpdate | null {
  const parsedTags = parseSerializedTags(note.frontmatter.tags);
  const baseTags = parsedTags?.tags ?? getTags(note);
  const normalizedTags = normalizeThreadTags(baseTags);
  const tagsFixed = parsedTags?.fixedCount ?? 0;
  const tagsNormalized = countNormalizedTags(baseTags, normalizedTags);

  if (tagsFixed === 0 && tagsNormalized === 0) {
    return null;
  }

  return {
    path: note.path,
    tags: normalizedTags,
    tagsFixed,
    tagsNormalized,
  };
}

function parseSerializedTags(raw: unknown): { fixedCount: number; tags: string[] } | null {
  if (typeof raw !== 'string' || !raw.startsWith('[')) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }

    return {
      tags: parsed
        .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0),
      fixedCount: 1,
    };
  } catch {
    return null;
  }
}

function normalizeThreadTags(tags: string[]): string[] {
  return tags.map((tag) => TAG_NORMALIZATION_MAP[tag] ?? tag);
}

function countNormalizedTags(originalTags: string[], normalizedTags: string[]): number {
  let count = 0;

  for (const [index, originalTag] of originalTags.entries()) {
    if (normalizedTags.at(index) !== originalTag) {
      count += 1;
    }
  }

  return count;
}

function buildScratchCleanupOperations(
  sessionMap: Map<string, ScratchEntry[]>,
): ScratchCleanupOperation[] {
  const operations: ScratchCleanupOperation[] = [];
  const dreamsGroup = sessionMap.get(DREAMS_SESSION_ID);
  if (dreamsGroup !== undefined) {
    const dreamOperation = buildDreamScratchCleanupOperation(dreamsGroup);
    if (dreamOperation !== null) {
      operations.push(dreamOperation);
    }
  }

  for (const [sessionId, group] of sessionMap) {
    if (sessionId === DREAMS_SESSION_ID) {
      continue;
    }

    const operation = buildSessionScratchCleanupOperation(sessionId, group);
    if (operation !== null) {
      operations.push(operation);
    }
  }

  return operations;
}

function buildDreamScratchCleanupOperation(group: ScratchEntry[]): ScratchCleanupOperation | null {
  const orphanedStarts = findOrphanedDreamStarts(group);
  if (orphanedStarts.length === 0) {
    return null;
  }

  return {
    type: 'compact',
    sessionId: DREAMS_SESSION_ID,
    scratchEntriesPurged: Math.max(group.length - 1, 0),
    orphanedDreamStartsResolved: orphanedStarts.length,
    compactedContent: `[COMPACTED] Dreams session - resolved ${orphanedStarts.length} orphaned DREAM START marker(s) from interrupted run(s).`,
  };
}

function buildSessionScratchCleanupOperation(
  sessionId: string,
  group: ScratchEntry[],
): ScratchCleanupOperation | null {
  const newestTimestamp = findNewestScratchTimestamp(group);
  if (newestTimestamp.length === 0) {
    return null;
  }

  const ageHours = (Date.now() - new Date(newestTimestamp).getTime()) / DAY_MS * HOURS_PER_DAY;
  if (ageHours > STALE_SCRATCH_SESSION_MAX_AGE_HOURS) {
    return {
      type: 'prune',
      sessionId,
      scratchEntriesPurged: 0,
      orphanedDreamStartsResolved: 0,
    };
  }

  if (!isCompactedScratchGroup(group) && group.length > 1) {
    return {
      type: 'compact',
      sessionId,
      scratchEntriesPurged: group.length - 1,
      orphanedDreamStartsResolved: 0,
      compactedContent: `[AUTO-COMPACTED by Dreams] ${summarizeScratchEntries(group, AUTO_COMPACT_SUMMARY_LENGTH)}`,
    };
  }

  return null;
}

function findNewestScratchTimestamp(group: ScratchEntry[]): string {
  return group.reduce(
    (newestTimestamp, entry) =>
      entry.timestamp.localeCompare(newestTimestamp) > 0 ? entry.timestamp : newestTimestamp,
    '',
  );
}
