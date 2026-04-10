import type { DreamsUsage } from './providers/types';
import type { DreamsEngramContext } from './prompt';

export type DreamsFocus =
  | 'state_distribution'
  | 'thread_coverage'
  | 'thread_health'
  | 'merge_candidates'
  | 'data_quality'
  | 'scratch_health'
  | 'scratch_thread_alignment';

export interface StateMemoryEntry {
  path: string;
  updated: string;
  hasThread: boolean;
  hasSummary: boolean;
}

export interface StateDistribution {
  counts: Record<string, number>;
  total: number;
  memoriesByState: Record<string, StateMemoryEntry[]>;
}

export interface ThreadCoverageGap {
  path: string;
  threadTags: string[];
  hasThreadField: boolean;
  suggestedThreadId: string | null;
}

export interface MergeCandidate {
  paths: string[];
  similarity: number;
  sharedTags: string[];
  reason: string;
}

export interface DataQualityIssue {
  path: string;
  issues: string[];
}

export interface ScratchSessionHealth {
  sessionId: string;
  entryCount: number;
  oldestEntry: string;
  newestEntry: string;
  isCompacted: boolean;
}

export interface ScratchHealth {
  entryCount: number;
  totalSizeBytes: number;
  sessions: ScratchSessionHealth[];
  staleSessions: string[];
}

export interface ScratchThreadCandidate {
  sessionId: string;
  entryCount: number;
  newestEntry: string;
  isCompacted: boolean;
  candidateThreadId: string | null;
  similarity: number;
  reason: string;
  summary: string;
}

export interface ThreadHealthEntry {
  threadId: string;
  path: string;
  status: string;
  updated: string;
  contentBytes: number;
  lineCount: number;
  goalCount: number;
  pathCount: number;
  relatedThreadCount: number;
  isOversized: boolean;
  isStale: boolean;
}

export interface ThreadHealth {
  totalCount: number;
  totalSizeBytes: number;
  countsByStatus: Record<string, number>;
  threads: ThreadHealthEntry[];
  oversizedThreads: string[];
  staleThreads: string[];
}

export interface DreamsReport {
  timestamp: string;
  focusAreas: DreamsFocus[];
  stateDistribution: StateDistribution;
  threadCoverageGaps: ThreadCoverageGap[];
  threadHealth: ThreadHealth;
  mergeCandidates: MergeCandidate[];
  dataQualityIssues: DataQualityIssue[];
  scratchHealth: ScratchHealth;
  scratchThreadCandidates: ScratchThreadCandidate[];
}

export type DreamsAction =
  | {
      action: 'update_state';
      path: string;
      from: string;
      to: string;
      reason: string;
    }
  | {
      action: 'set_thread';
      path: string;
      thread_id: string;
      reason: string;
    }
  | {
      action: 'rewrite_thread';
      thread_id: string;
      content: string;
      reason: string;
    }
  | {
      action: 'update_thread_status';
      thread_id: string;
      from: string;
      to: string;
      reason: string;
    }
  | {
      action: 'merge_threads';
      source_thread_id: string;
      target_thread_id: string;
      reason: string;
    }
  | {
      action: 'merge';
      keep: string;
      remove: string[];
      merged_content: string;
      merged_summary: string;
      reason: string;
    }
  | {
      action: 'update_summary';
      path: string;
      summary: string;
      reason: string;
    }
  | {
      action: 'update_type';
      path: string;
      from: string;
      to: string;
      reason: string;
    }
  | {
      action: 'rewrite_content';
      path: string;
      content: string;
      summary: string;
      reason: string;
    }
  | {
      action: 'forget';
      path: string;
      reason: string;
    }
  | {
      action: 'compact_scratch';
      session_id: string;
      summary: string;
    }
  | {
      action: 'archive_forgotten';
    }
  | {
      action: 'flag_core_review';
      path: string;
      concern: string;
      suggested_change: string;
      reason: string;
    };

export interface DreamsReviewNote {
  kind: 'memory' | 'thread' | 'scratch';
  path: string;
  type: string;
  state: string;
  summary?: string;
  content: string;
  sessionId?: string;
  threadId?: string;
  description?: string;
  goals?: string[];
  relatedThreads?: string[];
  paths?: string[];
  reason?: string;
  newestEntry?: string;
  entryCount?: number;
}

export interface DreamsExecutionResult {
  dryRun: boolean;
  applied: number;
  skipped: number;
  details: string[];
}

export interface DreamsPlanResult {
  report: DreamsReport;
  reviewNotes: DreamsReviewNote[];
  rawResponse: string;
  actions: DreamsAction[];
  dream?: string;
  usage?: DreamsUsage;
}

export interface DreamsRunResult {
  report: DreamsReport;
  reviewNotes: DreamsReviewNote[];
  rawResponse: string;
  actions: DreamsAction[];
  dream?: string;
  usage?: DreamsUsage;
  execution: DreamsExecutionResult;
}

export interface DreamsRunRecord {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  usage?: DreamsUsage;
  dream?: string;
  actionCount: number;
  reviewNoteCount: number;
  executionMode: 'plan' | 'dry-run' | 'apply';
  appliedActions?: number;
  skippedActions?: number;
  reportSummary: {
    memoryCount: number;
    rememberedCount: number;
    defaultCount: number;
    threadCount: number;
    threadGapCount: number;
    oversizedThreadCount: number;
    staleThreadCount: number;
    dataQualityIssueCount: number;
    mergeCandidateCount: number;
    scratchEntryCount: number;
    staleScratchSessionCount: number;
  };
}

export interface DreamsRunHistory {
  version: 1;
  updatedAt: string;
  runs: DreamsRunRecord[];
}

export interface DreamsUsageTrend {
  latest?: DreamsRunRecord;
  baselineAverageTotalTokens?: number;
  recentAverageTotalTokens?: number;
  deltaFromBaseline?: number;
}

export interface DreamsRunnerOptions {
  vaultPath: string;
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey?: string;
  baseURL?: string;
  dryRun?: boolean;
  focus?: DreamsFocus[];
  engramContext?: DreamsEngramContext;
}
