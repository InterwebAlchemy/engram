import * as path from 'path';
import {
  MemoryManager,
  MemoryState,
  MemoryType,
  type ScratchEntry,
  type VaultNote,
} from '@interwebalchemy/engram-core';
import type {
  DataQualityIssue,
  DreamsFocus,
  DreamsReport,
  MergeCandidate,
  ScratchHealth,
  StateDistribution,
  ThreadCoverageGap,
} from './types';

const THREAD_TAG_PREFIX = 'engram/thread/';
const BASE_THREAD_TAG = 'engram/thread';
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_SCRATCH_DAYS = 2;
const COMPACTED_SCRATCH_MAX_AGE_DAYS = 7;

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
}

export class DreamsAnalyzer {
  constructor(private readonly manager: MemoryManager) {}

  /**
   * Run deterministic cleanup that doesn't need LLM judgment:
   * - Fix JSON-string tags → YAML arrays
   * - Normalize bare tags to engram/ namespace
   * - Purge compacted scratch entries older than 7 days
   * - Auto-compact scratch sessions older than 2 days
   */
  async preCleanup(): Promise<PreCleanupResult> {
    const result: PreCleanupResult = { tagsFixed: 0, tagsNormalized: 0, scratchEntriesPurged: 0 };

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

    // Purge old compacted scratch entries and auto-compact stale sessions
    const entries = await this.manager.readScratch({ limit: 10000 });
    const now = Date.now();
    const sessionMap = new Map<string, ScratchEntry[]>();

    for (const entry of entries) {
      const group = sessionMap.get(entry.sessionId) ?? [];
      group.push(entry);
      sessionMap.set(entry.sessionId, group);
    }

    for (const [sessionId, group] of sessionMap) {
      const newest = group.reduce((a, b) =>
        a.timestamp > b.timestamp ? a : b,
      );
      const ageDays = (now - new Date(newest.timestamp).getTime()) / DAY_MS;
      const isCompacted = group.some((e) => e.content.includes('[COMPACTED]'));

      // Purge compacted sessions older than 7 days
      if (isCompacted && ageDays > COMPACTED_SCRATCH_MAX_AGE_DAYS) {
        await this.manager.compactScratch({
          sessionId,
          thresholdMs: 0,
          compactedContent: `[PURGED] Session ${sessionId} — compacted entries older than ${COMPACTED_SCRATCH_MAX_AGE_DAYS} days removed by Dreams pre-cleanup.`,
        });
        result.scratchEntriesPurged += group.length - 1;
      }
      // Auto-compact uncompacted sessions older than 2 days
      else if (!isCompacted && ageDays > STALE_SCRATCH_DAYS) {
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
          'merge_candidates',
          'data_quality',
          'scratch_health',
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
    };

    const [
      stateDistribution,
      threadCoverageGaps,
      mergeCandidates,
      dataQualityIssues,
      scratchHealth,
    ] = await Promise.all([
      tasks.stateDistribution,
      tasks.threadCoverageGaps,
      tasks.mergeCandidates,
      tasks.dataQualityIssues,
      tasks.scratchHealth,
    ]);

    return {
      timestamp: new Date().toISOString(),
      focusAreas,
      stateDistribution,
      threadCoverageGaps,
      mergeCandidates,
      dataQualityIssues,
      scratchHealth,
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
      const needsSummary = state !== MemoryState.Core;
      const summary = note.frontmatter.summary;
      if (needsSummary && (typeof summary !== 'string' || summary.trim().length === 0)) {
        noteIssues.push('missing summary');
      }

      if (typeof note.frontmatter.bootstrap_state !== 'string') {
        noteIssues.push('missing bootstrap_state');
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

    const tokens = new Set(
      note.content
        .toLowerCase()
        .split(/[^a-z0-9]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4),
    );
    cache.set(note.path, tokens);
    return tokens;
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
