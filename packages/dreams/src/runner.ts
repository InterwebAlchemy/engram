import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { stderr } from 'node:process';
import { promisify } from 'node:util';
import {
  defaultMemoryConfig,
  MemoryManager,
  NodeAdapter,
} from '@interwebalchemy/engram-core';
import { DreamsAnalyzer, type PreCleanupResult } from './analyzer';
import { appendDreamsRunHistory } from './history';
import {
  buildDreamNarrativeMessages,
  buildDreamsMessages,
  type DreamsEngramContext,
} from './prompt';
import { createDreamsProvider, type DreamsMessage } from './providers';
import { loadReviewNotes } from './runner-review-notes';
import {
  buildDryRunExecution,
  parseDreamsResponse,
  protectCoreMemoryActions,
} from './runner-response';
import { executeDreamsActions } from './runner-actions';
import {
  buildDreamRunId,
  buildFallbackDreamNarrative,
  buildReportSummary,
  estimateDreamMaxTokens,
  resolveNarrativeProvider,
  writeDreamScratchEntry,
  writeDreamStartEntry,
} from './runner-support';
import type {
  DreamsPlanResult,
  DreamsReport,
  DreamsRunResult,
  DreamsRunnerOptions,
} from './types';

const REPO_ROOT_SEGMENTS_UP = '../../..';
const SNAPSHOT_LABEL = 'Dreams pre-run snapshot';
const SNAPSHOT_REASON = 'dreams-run';
const execFileAsync = promisify((
  command: string,
  args: string[],
  cwd: string,
  callback: (error: Error | null) => void,
): void => {
  execFile(command, args, { cwd }, (error) => {
    callback(error);
  });
});

interface PlanDreamsOptions {
  analyze: () => Promise<DreamsPlanResult['report']>;
  complete: (
    messages: ReturnType<typeof buildDreamsMessages>,
  ) => Promise<{ content: string; usage?: DreamsPlanResult['usage'] }>;
  engramContext?: DreamsEngramContext;
  manager: MemoryManager;
  narrativeComplete?: (
    messages: ReturnType<typeof buildDreamNarrativeMessages>,
  ) => Promise<{ content: string }>;
}

interface DreamsRuntime {
  adapter: NodeAdapter;
  config: ReturnType<typeof defaultMemoryConfig> & { engramRoot: string };
  manager: MemoryManager;
}

export async function runDreams(options: DreamsRunnerOptions): Promise<DreamsRunResult> {
  await createSnapshot(options.vaultPath, options.engramRoot);

  const runtime = createDreamsRuntime(options.vaultPath, options.engramRoot);
  const analyzer = new DreamsAnalyzer(runtime.manager);
  const preCleanup = await analyzer.preCleanup();
  writePreCleanupSummary(preCleanup);

  const report = await analyzer.analyze(options.focus);
  const reviewNotes = await loadReviewNotes(runtime.manager, report);
  const resolvedContext = await hydrateDreamsContext(runtime.manager, options.engramContext);
  const messages = buildDreamsMessages(report, reviewNotes, resolvedContext);
  const provider = createDreamsProvider(options.provider, {
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxTokens: estimateDreamMaxTokens(messages),
  });
  const narrativeOverride = resolveNarrativeProvider(options);
  const narrativeProvider = narrativeOverride === null
    ? provider
    : createDreamsProvider(narrativeOverride.provider, narrativeOverride.config);
  const shouldApply = options.dryRun !== true;

  if (shouldApply) {
    await writeDreamStartEntry(runtime.manager);
  }

  const completion = await provider.complete(messages);
  const parsedResponse = parseDreamsResponse(completion.content);
  const actions = protectCoreMemoryActions(parsedResponse.actions, report);
  const execution = shouldApply
    ? await executeDreamsActions({
        actions,
        adapter: runtime.adapter,
        archivePath: runtime.config.archivePath,
        engramRoot: runtime.config.engramRoot,
        manager: runtime.manager,
        vaultBasePath: runtime.config.basePath,
      })
    : buildDryRunExecution(actions);
  const finalDream = await resolveDreamNarrative({
    actions,
    completionContent: completion.content,
    dryRun: options.dryRun,
    engramContext: resolvedContext,
    provider: narrativeProvider,
    report,
  });

  await appendDreamsRunHistory(runtime.adapter, {
    basePath: runtime.config.basePath,
    engramRoot: runtime.config.engramRoot,
    workingPath: runtime.config.workingPath,
    record: {
      id: buildDreamRunId(),
      timestamp: new Date().toISOString(),
      provider: options.provider,
      model: options.model,
      usage: completion.usage,
      dream: finalDream,
      actionCount: actions.length,
      reviewNoteCount: reviewNotes.length,
      executionMode: shouldApply ? 'apply' : 'dry-run',
      appliedActions: execution.applied,
      skippedActions: execution.skipped,
      reportSummary: buildReportSummary(report),
    },
  });

  if (shouldApply) {
    await writeDreamScratchEntry({
      actions,
      dream: finalDream,
      execution,
      manager: runtime.manager,
      report,
    });
  }

  return {
    report,
    reviewNotes,
    rawResponse: completion.content,
    actions,
    dream: finalDream,
    usage: completion.usage,
    execution,
  };
}

export async function runDreamsCleanup(
  options: Pick<DreamsRunnerOptions, 'engramRoot' | 'focus' | 'vaultPath'>,
): Promise<{ preCleanup: PreCleanupResult; report: DreamsReport }> {
  await createSnapshot(options.vaultPath, options.engramRoot);

  const runtime = createDreamsRuntime(options.vaultPath, options.engramRoot);
  const analyzer = new DreamsAnalyzer(runtime.manager);
  const preCleanup = await analyzer.preCleanup();
  const report = await analyzer.analyze(options.focus);

  return { preCleanup, report };
}

export async function planDreams(options: PlanDreamsOptions): Promise<DreamsPlanResult> {
  const report = await options.analyze();
  const reviewNotes = await loadReviewNotes(options.manager, report);
  const resolvedContext = await hydrateDreamsContext(options.manager, options.engramContext);
  const completion = await options.complete(
    buildDreamsMessages(report, reviewNotes, resolvedContext),
  );
  const parsedResponse = parseDreamsResponse(completion.content);
  const actions = protectCoreMemoryActions(parsedResponse.actions, report);
  const finalDream = await resolvePlannedDreamNarrative({
    actions,
    engramContext: resolvedContext,
    narrativeComplete: options.narrativeComplete,
    report,
  });

  return {
    report,
    reviewNotes,
    rawResponse: completion.content,
    actions,
    dream: finalDream,
    usage: completion.usage,
  };
}

export {
  buildDryRunExecution,
  estimateDreamMaxTokens,
  executeDreamsActions,
  loadReviewNotes,
  parseDreamsResponse,
  protectCoreMemoryActions,
  writeDreamScratchEntry,
  writeDreamStartEntry,
};

async function createSnapshot(vaultPath: string, engramRoot?: string): Promise<void> {
  const repoRoot = path.resolve(__dirname, REPO_ROOT_SEGMENTS_UP);
  const args = [
    'packages/snapshot/dist/index.js',
    'create',
    '--vault',
    vaultPath,
    '--label',
    SNAPSHOT_LABEL,
    '--reason',
    SNAPSHOT_REASON,
  ];

  if (engramRoot !== undefined && engramRoot.length > 0) {
    args.push('--engram-root', engramRoot);
  }

  await execFileAsync('node', args, repoRoot);
}

async function hydrateDreamsContext(
  manager: MemoryManager,
  context?: DreamsEngramContext,
): Promise<DreamsEngramContext | undefined> {
  const base: DreamsEngramContext = { ...(context ?? {}) };
  const withDate = hydrateCurrentDate(base);
  const soul = await manager.getSoulDocument().catch(() => null);
  if (soul === null) {
    return Object.keys(withDate).length > 0 ? withDate : undefined;
  }

  const hydratedContext = hydrateIdentitySummary(
    hydrateAgentName(withDate, soul.frontmatter.git_identity),
    soul.frontmatter.summary,
  );
  return Object.keys(hydratedContext).length > 0 ? hydratedContext : undefined;
}

function createDreamsRuntime(vaultPath: string, engramRoot?: string): DreamsRuntime {
  const adapter = new NodeAdapter();
  const baseConfig = defaultMemoryConfig(vaultPath);
  const config = {
    ...baseConfig,
    engramRoot: engramRoot ?? baseConfig.engramRoot,
  };

  return {
    adapter,
    config,
    manager: new MemoryManager(adapter, config),
  };
}

function writePreCleanupSummary(preCleanup: PreCleanupResult): void {
  const totalChanges =
    preCleanup.tagsFixed +
    preCleanup.tagsNormalized +
    preCleanup.scratchEntriesPurged +
    preCleanup.orphanedDreamStartsResolved;
  if (totalChanges === 0) {
    return;
  }

  stderr.write(
    `Pre-cleanup: ${preCleanup.tagsFixed} tags fixed, ${preCleanup.tagsNormalized} tags normalized, ${preCleanup.scratchEntriesPurged} scratch entries purged, ${preCleanup.orphanedDreamStartsResolved} orphaned dream starts resolved\n`,
  );
}

async function resolveDreamNarrative(options: {
  actions: DreamsPlanResult['actions'];
  completionContent: string;
  dryRun?: boolean;
  engramContext?: DreamsEngramContext;
  provider: { complete: (messages: DreamsMessage[]) => Promise<{ content: string }> };
  report: DreamsReport;
}): Promise<string> {
  if (options.dryRun === true) {
    return buildFallbackDreamNarrative(options.report, options.actions, options.engramContext);
  }

  try {
    const narrativeCompletion = await options.provider.complete(
      buildDreamNarrativeMessages(
        JSON.stringify(options.actions),
        options.report,
        options.engramContext,
      ),
    );
    const { content } = narrativeCompletion;
    if (content.trim().length > 0) {
      return content.trim();
    }
  } catch (error) {
    stderr.write(
      `[Dreams] Narrative call failed, using fallback: ${error instanceof Error ? error.message : 'unknown error'}\n`,
    );
  }

  return buildFallbackDreamNarrative(options.report, options.actions, options.engramContext);
}

async function resolvePlannedDreamNarrative(options: {
  actions: DreamsPlanResult['actions'];
  engramContext?: DreamsEngramContext;
  narrativeComplete?: (
    messages: ReturnType<typeof buildDreamNarrativeMessages>,
  ) => Promise<{ content: string }>;
  report: DreamsReport;
}): Promise<string> {
  if (options.narrativeComplete !== undefined) {
    try {
      const narrativeResult = await options.narrativeComplete(
        buildDreamNarrativeMessages(
          JSON.stringify(options.actions),
          options.report,
          options.engramContext,
        ),
      );
      if (narrativeResult.content.trim().length > 0) {
        return narrativeResult.content.trim();
      }
    } catch (error) {
      stderr.write(
        `[Dreams] Narrative call failed, using fallback: ${error instanceof Error ? error.message : 'unknown error'}\n`,
      );
    }
  }

  return buildFallbackDreamNarrative(options.report, options.actions, options.engramContext);
}

const ISO_DATE_LENGTH = 10;

function hydrateCurrentDate(context: DreamsEngramContext): DreamsEngramContext {
  const { currentDate } = context;
  if (currentDate !== undefined && currentDate.trim().length > 0) {
    return context;
  }

  return { ...context, currentDate: new Date().toISOString().slice(0, ISO_DATE_LENGTH) };
}

function hydrateAgentName(
  context: DreamsEngramContext,
  gitIdentity: unknown,
): DreamsEngramContext {
  if (context.agentName !== undefined && context.agentName.length > 0) {
    return context;
  }

  if (typeof gitIdentity !== 'string' || gitIdentity.trim().length === 0) {
    return context;
  }

  const [rawAgentName] = gitIdentity.split('<');
  const agentName = rawAgentName.trim();
  if (agentName.length === 0) {
    return context;
  }

  return { ...context, agentName };
}

function hydrateIdentitySummary(
  context: DreamsEngramContext,
  summary: unknown,
): DreamsEngramContext {
  if (context.identitySummary !== undefined && context.identitySummary.length > 0) {
    return context;
  }

  if (typeof summary !== 'string' || summary.trim().length === 0) {
    return context;
  }

  return { ...context, identitySummary: summary.trim() };
}
