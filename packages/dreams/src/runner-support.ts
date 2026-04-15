import {
  ContextBuilder,
  type MemoryManager,
} from '@interwebalchemy/engram-core';
import type { DreamsEngramContext } from './prompt';
import type { DreamsMessage } from './providers';
import type {
  DreamsAction,
  DreamsExecutionResult,
  DreamsReport,
  DreamsRunRecord,
} from './types';

const DREAMS_SESSION_ID = 'dreams';
const MIN_DREAM_COMPLETION_TOKENS = 8_000;
const MAX_DREAM_COMPLETION_TOKENS = 32_000;
const PROMPT_TO_COMPLETION_RATIO = 0.5;
const ACTION_SEPARATOR = '; ';

export function buildReportSummary(report: DreamsReport): DreamsRunRecord['reportSummary'] {
  return {
    memoryCount: report.stateDistribution.total,
    rememberedCount: report.stateDistribution.counts.remembered,
    defaultCount: report.stateDistribution.counts.default,
    threadCount: report.threadHealth.totalCount,
    threadGapCount: report.threadCoverageGaps.length,
    oversizedThreadCount: report.threadHealth.oversizedThreads.length,
    staleThreadCount: report.threadHealth.staleThreads.length,
    dataQualityIssueCount: report.dataQualityIssues.length,
    mergeCandidateCount: report.mergeCandidates.length,
    scratchEntryCount: report.scratchHealth.entryCount,
    staleScratchSessionCount: report.scratchHealth.staleSessions.length,
  };
}

export function buildFallbackDreamNarrative(
  report: DreamsReport,
  actions: DreamsAction[],
  context?: DreamsEngramContext,
): string {
  const { name } = resolveAgentName(context);
  const forgetCount = countActions(actions, 'forget');
  const mergeCount = countActions(actions, 'merge');
  const { length: rewriteCount } = actions.filter(
    (action) => action.action === 'rewrite_content' || action.action === 'rewrite_thread',
  );

  const fragments: string[] = [];
  if (forgetCount > 0) {
    fragments.push(`${forgetCount} dissolving into mist`);
  }
  if (mergeCount > 0) {
    fragments.push(`${mergeCount} fusing where they overlapped`);
  }
  if (rewriteCount > 0) {
    fragments.push(`${rewriteCount} reshaped underfoot`);
  }

  const reshaping = fragments.length > 0
    ? fragments.join(', ')
    : 'the terrain holding steady where it was already quiet';

  return `The dreamscape held ${report.stateDistribution.total} memories across ${report.threadHealth.totalCount} pathways. I moved through ${name}'s vault - ${reshaping}. The dream passed without the Dreamer's voice, only the reshaping remains.`;
}

export async function writeDreamStartEntry(manager: MemoryManager): Promise<void> {
  await manager.appendScratch(
    DREAMS_SESSION_ID,
    '[DREAM START] Falling asleep... vault analysis and consolidation beginning.',
  );
}

export async function writeDreamScratchEntry(options: {
  actions: DreamsAction[];
  dream?: string;
  execution: DreamsExecutionResult;
  manager: MemoryManager;
  report: DreamsReport;
}): Promise<void> {
  const {
    actions,
    dream,
    execution,
    manager,
    report,
  } = options;
  const narrative = dream ?? 'The dream passed without leaving an impression - only the actions remain.';
  await manager.appendScratch(DREAMS_SESSION_ID, `[DREAMING] ${narrative}`);

  const coreReviewFlags = actions.filter(
    (action): action is Extract<DreamsAction, { action: 'flag_core_review' }> =>
      action.action === 'flag_core_review',
  );
  if (coreReviewFlags.length > 0) {
    const followUps = coreReviewFlags
      .map((flag) => `${flag.path} -> ${flag.concern} Suggested: ${flag.suggested_change}`)
      .join(' | ');
    await manager.appendScratch(
      DREAMS_SESSION_ID,
      `[DREAM STATE] Core review for next Fragment: ${followUps}`,
    );
  }

  const actionBreakdown = summarizeActions(actions);
  const lines = [
    `[DREAM END] ${execution.applied} actions applied, ${execution.skipped} skipped.`,
    `Vault: ${report.stateDistribution.total} memories (${report.stateDistribution.counts.remembered} remembered, ${report.stateDistribution.counts.default} default).`,
    actionBreakdown.length > 0 ? `Actions: ${actionBreakdown.join(ACTION_SEPARATOR)}.` : '',
  ]
    .filter((line) => line.length > 0)
    .join(' | ');

  await manager.appendScratch(DREAMS_SESSION_ID, lines);
}

export function buildDreamRunId(): string {
  return `dream-${new Date().toISOString().replace(/[:.]/gu, '').replace('Z', 'Z')}`;
}

export function estimateDreamMaxTokens(messages: DreamsMessage[]): number {
  const estimator = new ContextBuilder();
  const promptTokens = messages.reduce(
    (sum, message) => sum + estimator.estimateTokens(message.content),
    0,
  );

  return Math.max(
    MIN_DREAM_COMPLETION_TOKENS,
    Math.min(
      MAX_DREAM_COMPLETION_TOKENS,
      Math.ceil(promptTokens * PROMPT_TO_COMPLETION_RATIO),
    ),
  );
}

function resolveAgentName(context?: DreamsEngramContext): { name: string } {
  const agentName = context?.agentName;
  return {
    name: agentName !== undefined && agentName.length > 0 ? agentName : 'the agent',
  };
}

function countActions(actions: DreamsAction[], actionName: DreamsAction['action']): number {
  return actions.filter((action) => action.action === actionName).length;
}

function summarizeActions(actions: DreamsAction[]): string[] {
  const counts = new Map<string, number>();

  for (const action of actions) {
    counts.set(action.action, (counts.get(action.action) ?? 0) + 1);
  }

  return [...counts.entries()].map(([action, count]) => `${count} ${action}`);
}
