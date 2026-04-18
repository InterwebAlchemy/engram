import type {
  ChatMessage,
  MemoryManager,
} from '@interwebalchemy/engram-core';
import { DreamsAnalyzer, type PreCleanupResult } from '../../../dreams/src/analyzer';
import {
  estimateDreamMaxTokens,
  planDreams,
} from '../../../dreams/src/runner';
import { KNOWN_MODELS } from '../constants';
import type { EngramSettings } from '../constants';
import type {
  DreamsExecutionResult,
  DreamsPlanResult,
  DreamsReport,
  DreamsRunRecord,
} from '../../../dreams/src/types';
import type { ProviderAdapter } from '../providers/types';
import type { SnapshotManager } from '../../../snapshot/src/manager';
import type { SnapshotRecord } from '../../../snapshot/src/types';

export interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

interface ModelSelection {
  providerId: string;
  modelId: string;
}

interface CreateDreamPlanOptions {
  selection: ModelOption;
  manager: MemoryManager;
  analyzer: DreamsAnalyzer;
  provider: ProviderAdapter;
  narrativeMaxTokens: number;
}

interface RunPowerNapOptions {
  manager: MemoryManager;
  snapshotManager: SnapshotManager;
  vaultPath: string;
  engramRoot: string;
}

export interface PowerNapResult {
  preCleanup: PreCleanupResult;
  report: DreamsReport;
  snapshot: SnapshotRecord;
  snapshots: SnapshotRecord[];
}

export function getModelOptions(settings: EngramSettings): ModelOption[] {
  const options: ModelOption[] = [];

  for (const [providerId, cfg] of Object.entries(settings.providers)) {
    for (const modelId of cfg.enabledModels) {
      const knownModels = KNOWN_MODELS[providerId] ?? [];
      const modelName = knownModels.find((model) => model.id === modelId)?.name ?? modelId;
      options.push({
        providerId,
        providerName: cfg.name,
        modelId,
        modelName,
      });
    }
  }

  return options;
}

export function syncModelSelection(
  settings: EngramSettings,
  current: ModelSelection,
  options: ModelOption[] = getModelOptions(settings),
): ModelSelection {
  const currentExists = options.some(
    (option) =>
      option.providerId === current.providerId &&
      option.modelId === current.modelId,
  );
  if (currentExists) {
    return current;
  }

  const { activeProviderId, providers } = settings;
  const { [activeProviderId]: activeProvider } = providers;
  const { defaultModel: activeModelId } = activeProvider;
  const preferred = options.find(
    (option) =>
      option.providerId === activeProviderId &&
      option.modelId === activeModelId,
  );
  if (preferred === undefined) {
    return { providerId: '', modelId: '' };
  }

  const { providerId, modelId } = preferred;
  return { providerId, modelId };
}

export function findSelectedOption(
  options: ModelOption[],
  selection: ModelSelection,
): ModelOption | null {
  return options.find(
    (option) =>
      option.providerId === selection.providerId &&
      option.modelId === selection.modelId,
  ) ?? null;
}

export function formatLatestDreamLabel(
  selected: ModelOption | null,
  latestPlan: DreamsPlanResult | null,
  latestExecution: DreamsExecutionResult | null,
): string {
  const providerLabel = selected === null
    ? 'Unknown model'
    : `${selected.providerName} · ${selected.modelName}`;
  const usageLabel = latestPlan?.usage?.total_tokens === undefined
    ? ''
    : ` · ${latestPlan.usage.total_tokens} tokens`;
  const executionLabel = latestExecution === null
    ? ''
    : ` · ${latestExecution.applied} actions applied`;
  return `${providerLabel}${usageLabel}${executionLabel}`;
}

export function createDreamRunRecord(
  selection: ModelOption,
  plan: DreamsPlanResult,
  execution: DreamsExecutionResult | null,
): DreamsRunRecord {
  const timestamp = new Date().toISOString();
  const idTimestamp = timestamp.replaceAll(':', '').replaceAll('.', '');

  return {
    id: `dream-${idTimestamp}`,
    timestamp,
    provider: selection.providerId,
    model: selection.modelId,
    usage: plan.usage,
    dream: plan.dream,
    actionCount: plan.actions.length,
    reviewNoteCount: plan.reviewNotes.length,
    executionMode: 'apply',
    appliedActions: execution?.applied,
    skippedActions: execution?.skipped,
    reportSummary: {
      memoryCount: plan.report.stateDistribution.total,
      rememberedCount: plan.report.stateDistribution.counts.remembered,
      defaultCount: plan.report.stateDistribution.counts.default,
      threadCount: plan.report.threadHealth.totalCount,
      threadGapCount: plan.report.threadCoverageGaps.length,
      oversizedThreadCount: plan.report.threadHealth.oversizedThreads.length,
      staleThreadCount: plan.report.threadHealth.staleThreads.length,
      dataQualityIssueCount: plan.report.dataQualityIssues.length,
      mergeCandidateCount: plan.report.mergeCandidates.length,
      scratchEntryCount: plan.report.scratchHealth.entryCount,
      staleScratchSessionCount: plan.report.scratchHealth.staleSessions.length,
    },
  };
}

export function buildDreamCompletionNotice(
  plan: DreamsPlanResult,
  execution: DreamsExecutionResult | null,
): string {
  const applied = execution?.applied ?? 0;
  const usageLabel = plan.usage?.total_tokens === undefined
    ? ''
    : ` · ${plan.usage.total_tokens} tokens`;
  return `Dream complete: ${applied} actions applied${usageLabel}`;
}

export async function createDreamPlan(
  options: CreateDreamPlanOptions,
): Promise<DreamsPlanResult> {
  const {
    selection,
    manager,
    analyzer,
    provider,
    narrativeMaxTokens,
  } = options;
  const engramContext = await getDreamEngramContext(manager);

  return await planDreams({
    manager,
    analyze: async () => await analyzer.analyze(),
    complete: async (messages) => {
      const maxTokens = estimateDreamMaxTokens(messages);
      const result = await provider.complete(messages as ChatMessage[], {
        model: selection.modelId,
        temperature: 0,
        maxTokens,
      });
      return {
        content: result.content.trim(),
        usage: result.usage,
      };
    },
    engramContext,
    narrativeComplete: async (messages) => {
      const result = await provider.complete(messages as ChatMessage[], {
        model: selection.modelId,
        temperature: 0.7,
        maxTokens: narrativeMaxTokens,
      });
      return { content: result.content.trim() };
    },
  });
}

export async function runPowerNap(
  options: RunPowerNapOptions,
): Promise<PowerNapResult> {
  const analyzer = new DreamsAnalyzer(options.manager);
  const snapshot = await options.snapshotManager.create({
    vaultPath: options.vaultPath,
    engramRoot: options.engramRoot,
    label: 'Power Nap pre-run snapshot',
    reason: 'obsidian-power-nap',
  });
  const preCleanup = await analyzer.preCleanup();
  const [report, snapshots] = await Promise.all([
    analyzer.analyze(),
    options.snapshotManager.list(),
  ]);

  return {
    preCleanup,
    report,
    snapshot,
    snapshots,
  };
}

export function resolveAgentName(gitIdentity: unknown): string | undefined {
  if (typeof gitIdentity !== 'string') {
    return undefined;
  }

  const trimmedIdentity = gitIdentity.trim();
  if (trimmedIdentity.length === 0) {
    return undefined;
  }

  const [rawAgentName] = trimmedIdentity.split('<');
  const agentName = rawAgentName.trim();
  return agentName.length === 0 ? undefined : agentName;
}

export function resolveIdentitySummary(summary: unknown): string | undefined {
  if (typeof summary !== 'string') {
    return undefined;
  }

  const trimmedSummary = summary.trim();
  return trimmedSummary.length === 0 ? undefined : trimmedSummary;
}

async function getDreamEngramContext(manager: MemoryManager): Promise<{
  agentName: string | undefined;
  identitySummary: string | undefined;
}> {
  const soul = await manager.getSoulDocument();
  return {
    agentName: resolveAgentName(soul?.frontmatter.git_identity),
    identitySummary: resolveIdentitySummary(soul?.frontmatter.summary),
  };
}
