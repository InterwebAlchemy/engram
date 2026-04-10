import * as path from 'path';
import {
  MemoryManager,
  MemoryState,
  MemoryType,
  ThreadStatus,
  type ScratchEntry,
  type VaultNote,
} from '@interwebalchemy/engram-core';
import type {
  DataQualityIssue,
  DreamsFocus,
  DreamsReport,
  MergeCandidate,
  ScratchHealth,
  ScratchThreadCandidate,
  StateDistribution,
  ThreadHealth,
  ThreadHealthEntry,
  ThreadCoverageGap,
} from './types';

const THREAD_TAG_PREFIX = 'engram/thread/';
const BASE_THREAD_TAG = 'engram/thread';
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_SCRATCH_SESSION_MAX_AGE_HOURS = 12;
const STALE_THREAD_MAX_AGE_DAYS = 21;
const THREAD_CONTENT_MAX_BYTES = 1800;
const THREAD_CONTENT_MAX_LINES = 24;
const DREAMS_SESSION_ID = 'dreams';

/** Bare tag → engram/ namespace mapping for unambiguous cases. */
const TAG_NORMALIZATION_MAP: Record<string, string> = {
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

export interface PreCleanupResult {
  tagsFixed: number;
  tagsNormalized: number;
  scratchEntriesPurged: number;
  orphanedDreamStartsResolved: number;
}

type ScratchPrunableManager = MemoryManager & {
  pruneScratch(options: { sessionId: string; thresholdMs: number }): Promise<number>;
};

export class DreamsAnalyzer {
  constructor(private readonly manager: MemoryManager) {}

  private pruneScratch(sessionId: string, thresholdMs: number): Promise<number> {
    return (this.manager as ScratchPrunableManager).pruneScratch({ sessionId, thresholdMs });
  }

  /**
   * Run deterministic cleanup that doesn't need LLM judgment:
   * - Fix JSON-string tags → YAML arrays
   * - Normalize bare tags to engram/ namespace
   * - Delete stale scratch sessions older than 12 hours
   * - Auto-compact all multi-entry scratch sessions
   */
  async preCleanup(): Promise<PreCleanupResult> {
    const result: PreCleanupResult = { tagsFixed: 0, tagsNormalized: 0, scratchEntriesPurged: 0, orphanedDreamStartsResolved: 0 };

    // Fix tags on all notes
    const notes = await this.manager.list();
    for (const note of notes) {
      // Access raw value — may be a JSON string at runtime despite the type
      const raw: unknown = note.frontmatter.tags;
      let tags: string[] | null = null;
      let changed = false;

      // Fix JSON-string tags (e.g. '["foo", "bar"]' stored as a string)
      if (typeof raw === 'string' && raw.startsWith('[')) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            tags = parsed.filter(Boolean).map(String);
            changed = true;
            result.tagsFixed += 1;
          }
        } catch {
          // Not valid JSON — leave as-is
        }
      }

      if (!tags) {
        tags = this.getTags(note);
      }

      // Normalize bare tags to engram/ namespace
      const normalized = tags.map((tag) => {
        const mapped = TAG_NORMALIZATION_MAP[tag];
        if (mapped && tag !== mapped) {
          changed = true;
          result.tagsNormalized += 1;
          return mapped;
        }
        return tag;
      });

      if (changed) {
        await this.manager.update(note.path, undefined, { tags: normalized });
      }
    }

    // Aggressively prune scratch: compact ALL multi-entry sessions, purge old
    // compacted entries, and resolve orphaned Dream markers.
    const entries = await this.manager.readScratch({ limit: 10000 });
    const now = Date.now();
    const sessionMap = new Map<string, ScratchEntry[]>();

    for (const entry of entries) {
      const group = sessionMap.get(entry.sessionId) ?? [];
      group.push(entry);
      sessionMap.set(entry.sessionId, group);
    }

    // Resolve orphaned DREAM START entries (start without matching end)
    const dreamsGroup = sessionMap.get(DREAMS_SESSION_ID);
    if (dreamsGroup) {
      const starts = dreamsGroup.filter((e) => e.content.includes('[DREAM START]'));
      const ends = dreamsGroup.filter((e) => e.content.includes('[DREAM END]'));
      if (starts.length > ends.length) {
        // There are orphaned starts — compact the dreams session to clear them
        const latestEnd = ends.at(-1);
        const orphanedStarts = latestEnd
          ? starts.filter((s) => s.timestamp < latestEnd.timestamp)
          : starts.slice(0, starts.length - ends.length);
        if (orphanedStarts.length > 0) {
          // Remove orphaned starts by compacting the dreams session
          await this.manager.compactScratch({
            sessionId: DREAMS_SESSION_ID,
            thresholdMs: 0,
            compactedContent: `[COMPACTED] Dreams session — resolved ${orphanedStarts.length} orphaned DREAM START marker(s) from interrupted run(s).`,
          });
          result.scratchEntriesPurged += dreamsGroup.length - 1;
          result.orphanedDreamStartsResolved += orphanedStarts.length;
          // Remove from map so we don't process it again below
          sessionMap.delete(DREAMS_SESSION_ID);
        }
      }
    }

    for (const [sessionId, group] of sessionMap) {
      // Skip the dreams session — handled above
      if (sessionId === DREAMS_SESSION_ID) continue;

      const newest = group.reduce((a, b) =>
        a.timestamp > b.timestamp ? a : b,
      );
      const ageDays = (now - new Date(newest.timestamp).getTime()) / DAY_MS;
      const isCompacted = group.some((e) => e.content.includes('[COMPACTED]'));

      // Scratch is coordination state, not archive: drop whole stale sessions.
      if (ageDays * 24 > STALE_SCRATCH_SESSION_MAX_AGE_HOURS) {
        const removed = await this.pruneScratch(sessionId, 0);
        result.scratchEntriesPurged += removed;
      }
      // Compact ALL multi-entry sessions — not just stale ones
      else if (!isCompacted && group.length > 1) {
        const summary = group.map((e) => e.content).join(' | ').slice(0, 300);
        await this.manager.compactScratch({
          sessionId,
          thresholdMs: 0,
          compactedContent: `[AUTO-COMPACTED by Dreams] ${summary}`,
        });
        result.scratchEntriesPurged += group.length - 1;
      }
    }

    return result;
  }

  async analyze(focus?: DreamsFocus[]): Promise<DreamsReport> {
    const focusAreas: DreamsFocus[] = focus && focus.length > 0
      ? [...new Set(focus)]
      : [
          'state_distribution',
          'thread_coverage',
          'thread_health',
          'merge_candidates',
          'data_quality',
          'scratch_health',
          'scratch_thread_alignment',
        ];

    const notes = await this.manager.list();
    const tasks = {
      stateDistribution: this.runIfIncluded(
        focusAreas,
        'state_distribution',
        () => this.analyzeStateDistribution(notes),
        this.emptyStateDistribution(),
      ),
      threadCoverageGaps: this.runIfIncluded(
        focusAreas,
        'thread_coverage',
        () => this.analyzeThreadCoverage(notes),
        [] as ThreadCoverageGap[],
      ),
      threadHealth: this.runIfIncluded(
        focusAreas,
        'thread_health',
        () => this.analyzeThreadHealth(),
        this.emptyThreadHealth(),
      ),
      mergeCandidates: this.runIfIncluded(
        focusAreas,
        'merge_candidates',
        () => this.analyzeMergeCandidates(notes),
        [] as MergeCandidate[],
      ),
      dataQualityIssues: this.runIfIncluded(
        focusAreas,
        'data_quality',
        () => this.analyzeDataQuality(notes),
        [] as DataQualityIssue[],
      ),
      scratchHealth: this.runIfIncluded(
        focusAreas,
        'scratch_health',
        () => this.analyzeScratchHealth(),
        this.emptyScratchHealth(),
      ),
      scratchThreadCandidates: this.runIfIncluded(
        focusAreas,
        'scratch_thread_alignment',
        () => this.analyzeScratchThreadAlignment(),
        [] as ScratchThreadCandidate[],
      ),
    };

    const [
      stateDistribution,
      threadCoverageGaps,
      threadHealth,
      mergeCandidates,
      dataQualityIssues,
      scratchHealth,
      scratchThreadCandidates,
    ] = await Promise.all([
      tasks.stateDistribution,
      tasks.threadCoverageGaps,
      tasks.threadHealth,
      tasks.mergeCandidates,
      tasks.dataQualityIssues,
      tasks.scratchHealth,
      tasks.scratchThreadCandidates,
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

  private async runIfIncluded<T>(
    focusAreas: DreamsFocus[],
    focus: DreamsFocus,
    fn: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    if (!focusAreas.includes(focus)) return fallback;
    return fn();
  }

  private emptyStateDistribution(): StateDistribution {
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

  private emptyScratchHealth(): ScratchHealth {
    return {
      entryCount: 0,
      totalSizeBytes: 0,
      sessions: [],
      staleSessions: [],
    };
  }

  private emptyThreadHealth(): ThreadHealth {
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

  private async analyzeStateDistribution(notes: VaultNote[]): Promise<StateDistribution> {
    const distribution = this.emptyStateDistribution();

    for (const note of notes) {
      const state = String(note.frontmatter.memory_state ?? MemoryState.Default);
      if (!(state in distribution.counts)) {
        distribution.counts[state] = 0;
        distribution.memoriesByState[state] = [];
      }

      distribution.counts[state] += 1;
      distribution.memoriesByState[state].push({
        path: note.path,
        updated: String(note.frontmatter.updated ?? note.frontmatter.created ?? ''),
        hasThread: typeof note.frontmatter.thread === 'string' && note.frontmatter.thread.length > 0,
        hasSummary: typeof note.frontmatter.summary === 'string' && note.frontmatter.summary.trim().length > 0,
      });
    }

    for (const entries of Object.values(distribution.memoriesByState)) {
      entries.sort((a, b) => b.updated.localeCompare(a.updated));
    }

    distribution.total = notes.length;
    return distribution;
  }

  private async analyzeThreadCoverage(notes: VaultNote[]): Promise<ThreadCoverageGap[]> {
    const gaps = notes
      .map<ThreadCoverageGap | null>((note) => {
        const tags = this.getTags(note).filter(
          (tag) => tag.startsWith(THREAD_TAG_PREFIX) && tag !== BASE_THREAD_TAG,
        );
        const hasThreadField = typeof note.frontmatter.thread === 'string' && note.frontmatter.thread.length > 0;

        if (tags.length === 0 || hasThreadField) return null;

        return {
          path: note.path,
          threadTags: tags,
          hasThreadField,
          suggestedThreadId: tags[0]?.slice(THREAD_TAG_PREFIX.length) ?? null,
        };
      })
      .filter((gap): gap is ThreadCoverageGap => gap !== null);

    return gaps;
  }

  private async analyzeThreadHealth(): Promise<ThreadHealth> {
    const threads = await this.manager.listThreads();
    const countsByStatus: Record<string, number> = {
      [ThreadStatus.Active]: 0,
      [ThreadStatus.Paused]: 0,
      [ThreadStatus.Closed]: 0,
    };

    const entries = threads.map<ThreadHealthEntry>((thread) => {
      const status = String(thread.frontmatter.status ?? ThreadStatus.Active);
      countsByStatus[status] = (countsByStatus[status] ?? 0) + 1;

      const updated = String(thread.frontmatter.updated ?? thread.frontmatter.created ?? '');
      const content = thread.content ?? '';
      const contentBytes = Buffer.byteLength(content, 'utf8');
      const lineCount = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0).length;
      const ageDays = updated.length > 0
        ? (Date.now() - new Date(updated).getTime()) / DAY_MS
        : 0;
      const isOversized = contentBytes > THREAD_CONTENT_MAX_BYTES || lineCount > THREAD_CONTENT_MAX_LINES;
      const isStale = status !== ThreadStatus.Closed && updated.length > 0 && ageDays > STALE_THREAD_MAX_AGE_DAYS;

      return {
        threadId: String(thread.frontmatter.thread_id ?? ''),
        path: thread.path,
        status,
        updated,
        contentBytes,
        lineCount,
        goalCount: Array.isArray(thread.frontmatter.goals) ? thread.frontmatter.goals.length : 0,
        pathCount: Array.isArray(thread.frontmatter.paths) ? thread.frontmatter.paths.length : 0,
        relatedThreadCount: Array.isArray(thread.frontmatter.related_threads) ? thread.frontmatter.related_threads.length : 0,
        isOversized,
        isStale,
      };
    });

    entries.sort((left, right) => {
      if (left.isOversized !== right.isOversized) return Number(right.isOversized) - Number(left.isOversized);
      if (left.isStale !== right.isStale) return Number(right.isStale) - Number(left.isStale);
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

  private async analyzeMergeCandidates(notes: VaultNote[]): Promise<MergeCandidate[]> {
    const candidates: MergeCandidate[] = [];
    const tokenCache = new Map<string, Set<string>>();

    for (let i = 0; i < notes.length; i += 1) {
      for (let j = i + 1; j < notes.length; j += 1) {
        const left = notes[i];
        const right = notes[j];
        if (left.frontmatter.type !== right.frontmatter.type) continue;

        const leftTokens = this.getTokenSet(left, tokenCache);
        const rightTokens = this.getTokenSet(right, tokenCache);
        if (leftTokens.size === 0 || rightTokens.size === 0) continue;

        const similarity = this.jaccard(leftTokens, rightTokens);
        if (similarity <= 0.3) continue;

        const sharedTags = this.intersect(this.getTags(left), this.getTags(right));
        candidates.push({
          paths: [left.path, right.path],
          similarity: Number(similarity.toFixed(3)),
          sharedTags,
          reason: `Same type (${left.frontmatter.type}); Jaccard similarity ${similarity.toFixed(2)} across note content.`,
        });
      }
    }

    return candidates
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 10);
  }

  private async analyzeDataQuality(notes: VaultNote[]): Promise<DataQualityIssue[]> {
    const issues: DataQualityIssue[] = [];

    for (const note of notes) {
      const noteIssues: string[] = [];

      const state = note.frontmatter.memory_state as string | undefined;
      if (state && !Object.values(MemoryState).includes(state as MemoryState)) {
        noteIssues.push(`invalid memory_state "${state}"`);
      }

      if (!note.frontmatter.created || typeof note.frontmatter.created !== 'string') {
        noteIssues.push('missing created timestamp');
      }

      if (!note.frontmatter.updated || typeof note.frontmatter.updated !== 'string') {
        noteIssues.push('missing updated timestamp');
      }

      if (
        'bootstrap_state' in note.frontmatter &&
        note.frontmatter.bootstrap_state !== undefined &&
        !['full', 'partial', 'none'].includes(String(note.frontmatter.bootstrap_state))
      ) {
        noteIssues.push(`invalid bootstrap_state "${String(note.frontmatter.bootstrap_state)}"`);
      }

      if (
        'thread' in note.frontmatter &&
        note.frontmatter.thread !== undefined &&
        typeof note.frontmatter.thread !== 'string'
      ) {
        noteIssues.push('thread field is not a string');
      }

      if (
        'tags' in note.frontmatter &&
        note.frontmatter.tags !== undefined &&
        !Array.isArray(note.frontmatter.tags) &&
        typeof note.frontmatter.tags !== 'string'
      ) {
        noteIssues.push('tags field is neither array nor string');
      }

      // Core notes don't need summaries — they always load in full
      const needsSummary = state !== MemoryState.Core;
      const summary = note.frontmatter.summary;
      if (needsSummary && (typeof summary !== 'string' || summary.trim().length === 0)) {
        noteIssues.push('missing summary');
      }

      const typeMismatch = this.detectTypeMismatch(note);
      if (typeMismatch) {
        noteIssues.push(typeMismatch);
      }

      if (noteIssues.length > 0) {
        issues.push({
          path: note.path,
          issues: noteIssues,
        });
      }
    }

    return issues;
  }

  private async analyzeScratchThreadAlignment(): Promise<ScratchThreadCandidate[]> {
    const entries = await this.manager.readScratch({ limit: 10000 });
    const threads = (await this.manager.listThreads())
      .filter((thread) => String(thread.frontmatter.status ?? ThreadStatus.Active) !== ThreadStatus.Closed);
    const sessionMap = new Map<string, ScratchEntry[]>();

    for (const entry of entries) {
      if (entry.sessionId === DREAMS_SESSION_ID) continue;
      const group = sessionMap.get(entry.sessionId) ?? [];
      group.push(entry);
      sessionMap.set(entry.sessionId, group);
    }

    const candidates: ScratchThreadCandidate[] = [];
    for (const [sessionId, group] of sessionMap) {
      group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      const newestEntry = group[group.length - 1]?.timestamp ?? '';
      if (!newestEntry) continue;

      const ageMs = Date.now() - new Date(newestEntry).getTime();
      if (ageMs > 7 * DAY_MS) continue;

      const isCompacted = group.some((entry) => entry.content.includes('[COMPACTED]'));
      const summary = group.map((entry) => entry.content).join(' | ').slice(0, 500);
      const scratchText = group.map((entry) => entry.content).join('\n');
      const scratchTokens = this.getTextTokenSet(scratchText);

      let bestThreadId: string | null = null;
      let bestSimilarity = 0;
      let bestReason = '';

      for (const thread of threads) {
        const threadId = String(thread.frontmatter.thread_id ?? '');
        const threadName = typeof thread.frontmatter.name === 'string' ? thread.frontmatter.name : '';
        const threadBody = [
          threadId,
          threadName,
          typeof thread.frontmatter.description === 'string' ? thread.frontmatter.description : '',
          Array.isArray(thread.frontmatter.goals) ? thread.frontmatter.goals.join('\n') : '',
          thread.content ?? '',
        ].join('\n');
        const similarity = this.jaccard(scratchTokens, this.getTextTokenSet(threadBody));
        const lowerScratch = scratchText.toLowerCase();
        const directMention = (threadId && lowerScratch.includes(threadId.toLowerCase()))
          || (threadName && lowerScratch.includes(threadName.toLowerCase()));
        const adjustedSimilarity = directMention ? Math.max(similarity, 0.2) : similarity;

        if (adjustedSimilarity > bestSimilarity) {
          bestSimilarity = adjustedSimilarity;
          bestThreadId = threadId || null;
          bestReason = directMention
            ? `scratch directly references thread ${threadId || threadName}`
            : `scratch overlaps with thread ${threadId || threadName} at ${(adjustedSimilarity * 100).toFixed(0)}% similarity`;
        }
      }

      if (!bestThreadId || bestSimilarity < 0.08) continue;

      candidates.push({
        sessionId,
        entryCount: group.length,
        newestEntry,
        isCompacted,
        candidateThreadId: bestThreadId,
        similarity: Number(bestSimilarity.toFixed(3)),
        reason: bestReason,
        summary,
      });
    }

    return candidates
      .sort((left, right) => {
        if (left.isCompacted !== right.isCompacted) return Number(left.isCompacted) - Number(right.isCompacted);
        if (left.similarity !== right.similarity) return right.similarity - left.similarity;
        return right.newestEntry.localeCompare(left.newestEntry);
      })
      .slice(0, 8);
  }

  private async analyzeScratchHealth(): Promise<ScratchHealth> {
    const entries = await this.manager.readScratch({ limit: 10000 });
    const sessionMap = new Map<string, ScratchEntry[]>();

    for (const entry of entries) {
      const group = sessionMap.get(entry.sessionId) ?? [];
      group.push(entry);
      sessionMap.set(entry.sessionId, group);
    }

    const sessions = [...sessionMap.entries()]
      .map(([sessionId, group]) => {
        group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
        return {
          sessionId,
          entryCount: group.length,
          oldestEntry: group[0]?.timestamp ?? '',
          newestEntry: group[group.length - 1]?.timestamp ?? '',
          isCompacted: group.some((entry) => entry.content.includes('[COMPACTED]')),
        };
      })
      .sort((a, b) => a.newestEntry.localeCompare(b.newestEntry));

    const staleSessions = sessions
      .filter(
        (session) =>
          !session.isCompacted &&
          session.newestEntry.length > 0 &&
          Date.now() - new Date(session.newestEntry).getTime() > DAY_MS,
      )
      .map((session) => session.sessionId);

    const totalSizeBytes = entries.reduce((sum, entry) => {
      return sum + Buffer.byteLength(`[${entry.sessionId} | ${entry.timestamp}] ${entry.content}\n`, 'utf8');
    }, 0);

    return {
      entryCount: entries.length,
      totalSizeBytes,
      sessions,
      staleSessions,
    };
  }

  private getTags(note: VaultNote): string[] {
    const raw = note.frontmatter.tags;
    if (Array.isArray(raw)) return raw.filter(Boolean);
    if (typeof raw === 'string') return [raw];
    return [];
  }

  private getTokenSet(note: VaultNote, cache: Map<string, Set<string>>): Set<string> {
    const cached = cache.get(note.path);
    if (cached) return cached;

    const tokens = this.getTextTokenSet(note.content);
    cache.set(note.path, tokens);
    return tokens;
  }

  private getTextTokenSet(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4),
    );
  }

  private jaccard(left: Set<string>, right: Set<string>): number {
    const smaller = left.size <= right.size ? left : right;
    const larger = left.size <= right.size ? right : left;
    let intersection = 0;

    for (const token of smaller) {
      if (larger.has(token)) intersection += 1;
    }

    const union = left.size + right.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  private intersect(left: string[], right: string[]): string[] {
    const rightSet = new Set(right);
    return [...new Set(left.filter((tag) => rightSet.has(tag)))];
  }

  private detectTypeMismatch(note: VaultNote): string | null {
    const normalized = note.path.split(path.sep).join('/');
    const match = normalized.match(/\/memory\/([^/]+)\//);
    if (!match) return null;

    const actualDir = match[1];
    const expectedDir = this.expectedDirForType(String(note.frontmatter.type));
    if (!expectedDir || expectedDir === actualDir) return null;
    return `type/path mismatch: frontmatter type "${note.frontmatter.type}" expects memory/${expectedDir}/ but file is in memory/${actualDir}/`;
  }

  private expectedDirForType(type: string): string | null {
    switch (type) {
      case MemoryType.Fact:
        return 'facts';
      case MemoryType.Entity:
        return 'entities';
      case MemoryType.Reflection:
        return 'reflections';
      case MemoryType.Skill:
        return 'skills';
      default:
        return null;
    }
  }
}
