import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  ContextBuilder,
  defaultMemoryConfig,
  type FileSystemAdapter,
  MemoryManager,
  MemoryState,
  NodeAdapter,
  ThreadStatus,
  VaultNote,
} from '@interwebalchemy/engram-core';
import { DreamsAnalyzer, type PreCleanupResult } from './analyzer';
import { appendDreamsRunHistory } from './history';
import { buildDreamNarrativeMessages, buildDreamsMessages, type DreamsEngramContext } from './prompt';
import type { DreamsMessage } from './providers';
import { createDreamsProvider } from './providers';
import type {
  DreamsAction,
  DreamsExecutionResult,
  DreamsPlanResult,
  DreamsReport,
  DreamsRunRecord,
  DreamsReviewNote,
  DreamsRunResult,
  DreamsRunnerOptions,
} from './types';

const execFileAsync = promisify(execFile);

const TYPE_DIRS: Record<string, string> = {
  fact: 'facts',
  entity: 'entities',
  reflection: 'reflections',
  skill: 'skills',
};

export async function runDreams(options: DreamsRunnerOptions): Promise<DreamsRunResult> {
  await createSnapshot(options.vaultPath);

  const adapter = new NodeAdapter();
  const config = defaultMemoryConfig(options.vaultPath);
  const manager = new MemoryManager(adapter, config);
  const analyzer = new DreamsAnalyzer(manager);

  // Deterministic cleanup before LLM analysis
  const preCleanup = await analyzer.preCleanup();
  if (preCleanup.tagsFixed + preCleanup.tagsNormalized + preCleanup.scratchEntriesPurged + preCleanup.orphanedDreamStartsResolved > 0) {
    console.log(
      `Pre-cleanup: ${preCleanup.tagsFixed} tags fixed, ${preCleanup.tagsNormalized} tags normalized, ${preCleanup.scratchEntriesPurged} scratch entries purged, ${preCleanup.orphanedDreamStartsResolved} orphaned dream starts resolved`,
    );
  }

  const report = await analyzer.analyze(options.focus);
  const reviewNotes = await loadReviewNotes(manager, report);
  const engramContext = await hydrateDreamsContext(manager, options.engramContext);

  const messages = buildDreamsMessages(report, reviewNotes, engramContext);
  const maxTokens = estimateDreamMaxTokens(messages);

  const provider = createDreamsProvider(options.provider, {
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    maxTokens,
  });

  if (!options.dryRun) {
    await writeDreamStartEntry(manager);
  }

  const completion = await provider.complete(messages);
  const rawResponse = completion.content;
  const parsedResponse = parseDreamsResponse(rawResponse);
  const actions = protectCoreMemoryActions(parsedResponse.actions, report);
  const execution = options.dryRun
    ? buildDryRunExecution(actions)
    : await executeDreamsActions(actions, manager, adapter, config.basePath, config.engramRoot, config.archivePath);

  // Separate call for the dream narrative — cheap, short, and safe from truncation
  let dream: string | undefined;
  if (!options.dryRun) {
    try {
      const narrativeCompletion = await provider.complete(
        buildDreamNarrativeMessages(JSON.stringify(actions), report, engramContext),
      );
      dream = narrativeCompletion.content.trim() || undefined;
    } catch (err) {
      // Non-fatal — we still have the actions and execution, but log it
      console.warn('[Dreams] Narrative call failed, using fallback:', err instanceof Error ? err.message : err);
    }
  }

  const finalDream = dream || buildFallbackDreamNarrative(report, actions, engramContext);
  const totalUsage = completion.usage;

  await appendDreamsRunHistory(adapter, config.basePath, config.engramRoot, config.workingPath, {
    id: buildDreamRunId(),
    timestamp: new Date().toISOString(),
    provider: options.provider,
    model: options.model,
    usage: totalUsage,
    dream: finalDream,
    actionCount: actions.length,
    reviewNoteCount: reviewNotes.length,
    executionMode: options.dryRun ? 'dry-run' : 'apply',
    appliedActions: execution.applied,
    skippedActions: execution.skipped,
    reportSummary: buildReportSummary(report),
  });

  // Leave a trace in scratch so the next fragment knows a dream just happened
  if (!options.dryRun) {
    await writeDreamScratchEntry(manager, execution, actions, report, finalDream);
  }

  return {
    report,
    reviewNotes,
    rawResponse,
    actions,
    dream: finalDream,
    usage: totalUsage,
    execution,
  };
}

export async function runDreamsCleanup(
  options: Pick<DreamsRunnerOptions, 'vaultPath' | 'focus'>,
): Promise<{ preCleanup: PreCleanupResult; report: DreamsReport }> {
  await createSnapshot(options.vaultPath);

  const adapter = new NodeAdapter();
  const config = defaultMemoryConfig(options.vaultPath);
  const manager = new MemoryManager(adapter, config);
  const analyzer = new DreamsAnalyzer(manager);

  const preCleanup = await analyzer.preCleanup();
  const report = await analyzer.analyze(options.focus);

  return { preCleanup, report };
}

export async function planDreams(
  manager: MemoryManager,
  analyze: () => Promise<DreamsPlanResult['report']>,
  complete: (messages: ReturnType<typeof buildDreamsMessages>) => Promise<{ content: string; usage?: DreamsPlanResult['usage'] }>,
  engramContext?: DreamsEngramContext,
  narrativeComplete?: (messages: ReturnType<typeof buildDreamNarrativeMessages>) => Promise<{ content: string }>,
): Promise<DreamsPlanResult> {
  const report = await analyze();
  const reviewNotes = await loadReviewNotes(manager, report);
  const resolvedContext = await hydrateDreamsContext(manager, engramContext);
  const completion = await complete(buildDreamsMessages(report, reviewNotes, resolvedContext));
  const rawResponse = completion.content;
  const parsedResponse = parseDreamsResponse(rawResponse);
  const actions = protectCoreMemoryActions(parsedResponse.actions, report);

  // Separate call for the dream narrative
  let dream: string | undefined;
  if (narrativeComplete) {
    try {
      const narrativeResult = await narrativeComplete(
        buildDreamNarrativeMessages(JSON.stringify(actions), report, resolvedContext),
      );
      dream = narrativeResult.content.trim() || undefined;
    } catch (err) {
      // Non-fatal — fallback narrative will be used
      console.warn('[Dreams] Narrative call failed, using fallback:', err instanceof Error ? err.message : err);
    }
  }

  const finalDream = dream || buildFallbackDreamNarrative(report, actions, resolvedContext);

  return {
    report,
    reviewNotes,
    rawResponse,
    actions,
    dream: finalDream,
    usage: completion.usage,
  };
}

async function createSnapshot(vaultPath: string): Promise<void> {
  const repoRoot = path.resolve(__dirname, '../../..');
  await execFileAsync('node', [
    'packages/snapshot/dist/index.js',
    'create',
    '--vault',
    vaultPath,
    '--snapshots-dir',
    path.join(repoRoot, '.snapshots'),
    '--label',
    'Dreams pre-run snapshot',
    '--reason',
    'dreams-run',
  ], {
    cwd: repoRoot,
  });
}

async function hydrateDreamsContext(
  manager: MemoryManager,
  context?: DreamsEngramContext,
): Promise<DreamsEngramContext | undefined> {
  const next: DreamsEngramContext = { ...(context ?? {}) };
  const soul = await manager.getSoulDocument().catch(() => null);

  if (soul) {
    if (!next.agentName) {
      const gitIdentity = soul.frontmatter.git_identity;
      if (typeof gitIdentity === 'string' && gitIdentity.trim().length > 0) {
        next.agentName = gitIdentity.split('<')[0]?.trim() || undefined;
      }
    }

    if (!next.identitySummary) {
      const summary = soul.frontmatter.summary;
      if (typeof summary === 'string' && summary.trim().length > 0) {
        next.identitySummary = summary.trim();
      }
    }
  }

  return Object.keys(next).length > 0 ? next : undefined;
}

export async function loadReviewNotes(
  manager: MemoryManager,
  report: DreamsRunResult['report'],
): Promise<DreamsReviewNote[]> {
  const paths = new Set<string>();
  const threadIds = new Set<string>();
  const corePaths = new Set<string>();
  for (const entry of report.stateDistribution.memoriesByState.core ?? []) {
    corePaths.add(entry.path);
    paths.add(entry.path);
  }

  // Include remembered and default notes for LLM review
  for (const entry of report.stateDistribution.memoriesByState.remembered ?? []) {
    paths.add(entry.path);
  }
  for (const entry of report.stateDistribution.memoriesByState.default ?? []) {
    paths.add(entry.path);
  }
  // Include notes flagged by analysis
  for (const candidate of report.mergeCandidates) {
    for (const candidatePath of candidate.paths) paths.add(candidatePath);
  }
  for (const gap of report.threadCoverageGaps) {
    paths.add(gap.path);
  }
  for (const issue of report.dataQualityIssues) {
    paths.add(issue.path);
  }
  for (const candidate of report.scratchThreadCandidates) {
    if (candidate.candidateThreadId) threadIds.add(candidate.candidateThreadId);
  }

  for (const threadId of report.threadHealth.oversizedThreads) {
    threadIds.add(threadId);
  }
  for (const threadId of report.threadHealth.staleThreads) {
    threadIds.add(threadId);
  }
  for (const thread of report.threadHealth.threads) {
    if (thread.status !== ThreadStatus.Closed && threadIds.size < 5) {
      threadIds.add(thread.threadId);
    }
  }

  const notes = await Promise.all(
    [...paths].map(async (notePath) => {
      try {
        const note = await manager.read(notePath);
        return note;
      } catch {
        return null;
      }
    }),
  );

  const reviewNotes = notes
    .filter((note): note is VaultNote => note !== null)
    .map((note) => ({
      kind: 'memory' as const,
      path: note.path,
      type: String(note.frontmatter.type),
      state: String(note.frontmatter.memory_state ?? MemoryState.Default),
      summary: typeof note.frontmatter.summary === 'string' ? note.frontmatter.summary : undefined,
      content: note.content,
    }));

  const threads = await Promise.all(
    [...threadIds].map(async (threadId) => {
      try {
        const thread = await manager.getThread(threadId);
        return thread;
      } catch {
        return null;
      }
    }),
  );

  return [
    ...reviewNotes,
    ...threads
      .filter((thread): thread is VaultNote => thread !== null)
      .map((thread) => ({
        kind: 'thread' as const,
        path: thread.path,
        type: 'thread',
        state: String(thread.frontmatter.status ?? ThreadStatus.Active),
        content: thread.content,
        threadId: String(thread.frontmatter.thread_id ?? ''),
        description: typeof thread.frontmatter.description === 'string' ? thread.frontmatter.description : undefined,
        goals: Array.isArray(thread.frontmatter.goals) ? thread.frontmatter.goals.map(String) : undefined,
        relatedThreads: Array.isArray(thread.frontmatter.related_threads)
          ? thread.frontmatter.related_threads.map(String)
          : undefined,
        paths: Array.isArray(thread.frontmatter.paths) ? thread.frontmatter.paths.map(String) : undefined,
      })),
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

export function buildDryRunExecution(actions: DreamsAction[]): DreamsExecutionResult {
  return {
    dryRun: true,
    applied: 0,
    skipped: actions.length,
    details: actions.map((action) => `[dry-run] ${describeAction(action)}`),
  };
}

export async function executeDreamsActions(
  actions: DreamsAction[],
  manager: MemoryManager,
  adapter: FileSystemAdapter,
  vaultBasePath: string,
  engramRoot: string,
  archivePath: string,
): Promise<DreamsExecutionResult> {
  const details: string[] = [];
  let applied = 0;
  let skipped = 0;

  for (const action of actions) {
    switch (action.action) {
      case 'update_state':
        await manager.update(action.path, undefined, { memory_state: action.to as MemoryState });
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'set_thread':
        await manager.update(action.path, undefined, { thread: action.thread_id });
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'rewrite_thread':
        await manager.updateThread(action.thread_id, action.content);
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'update_thread_status':
        await manager.updateThread(action.thread_id, undefined, { status: action.to as ThreadStatus });
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'merge_threads':
        await manager.mergeThreads(action.source_thread_id, action.target_thread_id);
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'update_summary':
        await manager.update(action.path, undefined, { summary: action.summary });
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'rewrite_content':
        await manager.update(action.path, action.content, { summary: action.summary });
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'forget':
        await manager.update(action.path, undefined, { memory_state: MemoryState.Forgotten });
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'update_type':
        await moveNoteToTypePath(action.path, action.to, manager, adapter, vaultBasePath, engramRoot);
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'merge':
        await mergeNotes(action, manager, adapter, vaultBasePath, engramRoot, archivePath);
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'compact_scratch':
        await manager.compactScratch({
          sessionId: action.session_id,
          thresholdMs: 0,
          compactedContent: action.summary,
        });
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'archive_forgotten':
        await manager.archiveForgotten();
        details.push(describeAction(action));
        applied += 1;
        break;
      case 'flag_core_review':
        details.push(describeAction(action));
        applied += 1;
        break;
      default:
        skipped += 1;
        details.push(`Skipped unknown action: ${JSON.stringify(action)}`);
        break;
    }
  }

  return {
    dryRun: false,
    applied,
    skipped,
    details,
  };
}

async function moveNoteToTypePath(
  notePath: string,
  newType: string,
  manager: MemoryManager,
  adapter: FileSystemAdapter,
  vaultBasePath: string,
  engramRoot: string,
): Promise<void> {
  const note = await manager.read(notePath);
  const expectedDir = TYPE_DIRS[newType];

  if (!expectedDir) {
    await manager.update(notePath, undefined, { type: newType });
    return;
  }

  const writeRoot = path.join(vaultBasePath, engramRoot);
  const fileName = path.basename(note.path);
  const targetDir = path.join(writeRoot, 'memory', expectedDir);
  const targetPath = await resolveUniquePath(adapter, path.join(targetDir, fileName), note.path);

  if (targetPath === note.path) {
    await manager.update(notePath, undefined, { type: newType });
    return;
  }

  note.path = targetPath;
  note.updateFrontmatter({ type: newType });
  await adapter.mkdir(targetDir);
  await note.save(adapter);
  await adapter.delete(notePath);
}

async function mergeNotes(
  action: Extract<DreamsAction, { action: 'merge' }>,
  manager: MemoryManager,
  adapter: FileSystemAdapter,
  vaultBasePath: string,
  engramRoot: string,
  archivePath: string,
): Promise<void> {
  await manager.update(action.keep, action.merged_content, {
    summary: action.merged_summary,
  });

  for (const removePath of action.remove) {
    if (removePath === action.keep) continue;
    const note = await manager.read(removePath);
    const writeRoot = path.join(vaultBasePath, engramRoot);
    const relative = path.relative(writeRoot, note.path);
    const archiveTarget = await resolveUniquePath(
      adapter,
      path.join(writeRoot, archivePath, relative),
      '',
    );
    await adapter.mkdir(path.dirname(archiveTarget));
    await adapter.write(archiveTarget, note.serialize());
    await adapter.delete(note.path);
  }
}

async function resolveUniquePath(
  adapter: FileSystemAdapter,
  desiredPath: string,
  currentPath: string,
): Promise<string> {
  if (desiredPath === currentPath) return desiredPath;
  if (!(await adapter.exists(desiredPath))) return desiredPath;

  const parsed = path.parse(desiredPath);
  let attempt = 2;
  let candidate = desiredPath;

  while (await adapter.exists(candidate)) {
    candidate = path.join(parsed.dir, `${parsed.name}-${attempt}${parsed.ext}`);
    attempt += 1;
  }

  return candidate;
}

export interface ParsedDreamsResponse {
  actions: DreamsAction[];
  dream?: string;
}

export function protectCoreMemoryActions(
  actions: DreamsAction[],
  report: DreamsReport,
): DreamsAction[] {
  const corePaths = new Set(
    (report.stateDistribution.memoriesByState.core ?? []).map((entry) => entry.path),
  );

  if (corePaths.size === 0) return actions;

  return actions.flatMap((action) => convertCoreMutationToReviewFlag(action, corePaths));
}

export function parseDreamsResponse(rawResponse: string): ParsedDreamsResponse {
  const trimmed = rawResponse.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenceMatch?.[1] ?? extractJSONBody(trimmed);
  const parsed = tryParseJSON(candidate);

  // Object format: { actions: [...] }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'actions' in parsed) {
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.actions)) {
      throw new Error('Dreams response "actions" field is not an array.');
    }
    return {
      actions: normalizeDreamsActions(obj.actions),
    };
  }

  // Legacy format: bare JSON array
  if (Array.isArray(parsed)) {
    return { actions: normalizeDreamsActions(parsed) };
  }

  throw new Error('Dreams provider response was not a recognized format.');
}

/**
 * Attempt JSON.parse, and if it fails due to truncation, try to salvage
 * by extracting the actions array from the partial response.
 */
function tryParseJSON(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    // Response was likely truncated mid-JSON. Try to extract the actions array.
    const actionsMatch = candidate.match(/"actions"\s*:\s*\[/);
    if (!actionsMatch) throw new Error('Dreams response is not valid JSON and could not be repaired.');

    const arrStart = actionsMatch.index! + actionsMatch[0].length - 1;
    // Walk through the string to find complete action objects
    let depth = 0;
    let lastCompleteElement = -1;
    for (let i = arrStart; i < candidate.length; i++) {
      const ch = candidate[i];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) lastCompleteElement = i;
      }
    }

    if (lastCompleteElement === -1) {
      throw new Error('Dreams response is not valid JSON and could not be repaired.');
    }

    const repairedArray = candidate.slice(arrStart, lastCompleteElement + 1) + ']';
    const actions = JSON.parse(repairedArray);
    return { actions };
  }
}

function extractJSONBody(text: string): string {
  // Try object first (new format)
  const objStart = text.indexOf('{');
  const objEnd = text.lastIndexOf('}');
  if (objStart !== -1 && objEnd > objStart) {
    return text.slice(objStart, objEnd + 1);
  }
  // Fall back to array (legacy)
  const arrStart = text.indexOf('[');
  const arrEnd = text.lastIndexOf(']');
  if (arrStart !== -1 && arrEnd > arrStart) {
    return text.slice(arrStart, arrEnd + 1);
  }
  throw new Error('Could not find JSON in Dreams provider response.');
}

function normalizeDreamsActions(rawActions: unknown[]): DreamsAction[] {
  const issues: string[] = [];
  const actions: DreamsAction[] = [];

  for (const [index, rawAction] of rawActions.entries()) {
    try {
      actions.push(normalizeDreamAction(rawAction, index));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(message);
    }
  }

  if (issues.length > 0) {
    throw new Error(`Dreams response contained invalid actions: ${issues.join(' | ')}`);
  }

  return actions;
}

function normalizeDreamAction(rawAction: unknown, index: number): DreamsAction {
  const actionIndex = index + 1;
  const record = asRecord(rawAction, `Dreams action #${actionIndex} must be an object.`);
  const actionName = readString(record, ['action', 'type']);

  if (!actionName) {
    throw new Error(`Dreams action #${actionIndex} is missing an action name.`);
  }

  switch (actionName) {
    case 'update_state':
      return {
        action: 'update_state',
        path: requireString(record, ['path'], actionIndex),
        from: requireString(record, ['from'], actionIndex),
        to: requireString(record, ['to'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'set_thread':
      return {
        action: 'set_thread',
        path: requireString(record, ['path'], actionIndex),
        thread_id: requireString(record, ['thread_id', 'threadId'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'rewrite_thread':
      return {
        action: 'rewrite_thread',
        thread_id: requireString(record, ['thread_id', 'threadId'], actionIndex),
        content: requireString(record, ['content'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'update_thread_status':
      return {
        action: 'update_thread_status',
        thread_id: requireString(record, ['thread_id', 'threadId'], actionIndex),
        from: requireString(record, ['from'], actionIndex),
        to: requireString(record, ['to'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'merge_threads':
      return {
        action: 'merge_threads',
        source_thread_id: requireString(record, ['source_thread_id', 'sourceThreadId'], actionIndex),
        target_thread_id: requireString(record, ['target_thread_id', 'targetThreadId'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'merge':
      return {
        action: 'merge',
        keep: requireString(record, ['keep'], actionIndex),
        remove: requireStringArray(record, ['remove'], actionIndex),
        merged_content: requireString(record, ['merged_content', 'mergedContent'], actionIndex),
        merged_summary: requireString(record, ['merged_summary', 'mergedSummary'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'update_summary':
      return {
        action: 'update_summary',
        path: requireString(record, ['path'], actionIndex),
        summary: requireString(record, ['summary'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'update_type':
      return {
        action: 'update_type',
        path: requireString(record, ['path'], actionIndex),
        from: requireString(record, ['from'], actionIndex),
        to: requireString(record, ['to'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'rewrite_content':
      return {
        action: 'rewrite_content',
        path: requireString(record, ['path'], actionIndex),
        content: requireString(record, ['content'], actionIndex),
        summary: requireString(record, ['summary'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'forget':
      return {
        action: 'forget',
        path: requireString(record, ['path'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'compact_scratch':
      return {
        action: 'compact_scratch',
        session_id: requireString(record, ['session_id', 'sessionId'], actionIndex),
        summary: requireString(record, ['summary'], actionIndex),
      };
    case 'archive_forgotten':
      return { action: 'archive_forgotten' };
    case 'flag_core_review':
      return {
        action: 'flag_core_review',
        path: requireString(record, ['path'], actionIndex),
        concern: requireString(record, ['concern'], actionIndex),
        suggested_change: requireString(record, ['suggested_change', 'suggestedChange'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    default:
      throw new Error(`Dreams action #${actionIndex} has unknown action "${actionName}".`);
  }
}

function convertCoreMutationToReviewFlag(
  action: DreamsAction,
  corePaths: Set<string>,
): DreamsAction[] {
  if (action.action === 'flag_core_review') {
    return [action];
  }

  const affectedCorePaths = getAffectedCorePaths(action, corePaths);
  if (affectedCorePaths.length === 0) {
    return [action];
  }

  return affectedCorePaths.map((path) => ({
    action: 'flag_core_review' as const,
    path,
    concern: 'Core memory may need a manual update based on Dream analysis.',
    suggested_change: describeAction(action),
    reason: hasReason(action)
      ? action.reason
      : 'Dreams does not mutate core memories automatically; review this note manually.',
  }));
}

function getAffectedCorePaths(
  action: DreamsAction,
  corePaths: Set<string>,
): string[] {
  switch (action.action) {
    case 'update_state':
    case 'set_thread':
    case 'update_summary':
    case 'update_type':
    case 'rewrite_content':
    case 'forget':
    case 'flag_core_review':
      return corePaths.has(action.path) ? [action.path] : [];
    case 'merge': {
      const paths = [action.keep, ...action.remove];
      return paths.filter((path) => corePaths.has(path));
    }
    default:
      return [];
  }
}

function hasReason(
  action: DreamsAction,
): action is Extract<DreamsAction, { reason: string }> {
  return 'reason' in action && typeof action.reason === 'string';
}

function asRecord(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(errorMessage);
  }
  return value as Record<string, unknown>;
}

function readString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function requireString(
  record: Record<string, unknown>,
  keys: string[],
  actionIndex: number,
): string {
  const value = readString(record, keys);
  if (value) return value;

  throw new Error(
    `Dreams action #${actionIndex} is missing ${keys.map((key) => `"${key}"`).join(' or ')}.`,
  );
}

function requireStringArray(
  record: Record<string, unknown>,
  keys: string[],
  actionIndex: number,
): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      const items = value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (items.length > 0) return items;
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      return [value];
    }
  }

  throw new Error(
    `Dreams action #${actionIndex} is missing ${keys.map((key) => `"${key}"`).join(' or ')}.`,
  );
}

export function describeAction(action: DreamsAction): string {
  switch (action.action) {
    case 'update_state':
      return `update_state ${action.path}: ${action.from} -> ${action.to}`;
    case 'set_thread':
      return `set_thread ${action.path}: ${action.thread_id}`;
    case 'rewrite_thread':
      return `rewrite_thread ${action.thread_id}`;
    case 'update_thread_status':
      return `update_thread_status ${action.thread_id}: ${action.from} -> ${action.to}`;
    case 'merge_threads':
      return `merge_threads ${action.source_thread_id} -> ${action.target_thread_id}`;
    case 'merge':
      return `merge keep=${action.keep} remove=${action.remove.join(', ')}`;
    case 'update_summary':
      return `update_summary ${action.path}`;
    case 'update_type':
      return `update_type ${action.path}: ${action.from} -> ${action.to}`;
    case 'rewrite_content':
      return `rewrite_content ${action.path}`;
    case 'forget':
      return `forget ${action.path}`;
    case 'compact_scratch':
      return `compact_scratch ${action.session_id}`;
    case 'archive_forgotten':
      return 'archive_forgotten';
    case 'flag_core_review':
      return `flag_core_review ${action.path}: ${action.concern}`;
  }
}

function buildReportSummary(report: DreamsRunResult['report']): DreamsRunRecord['reportSummary'] {
  return {
    memoryCount: report.stateDistribution.total,
    rememberedCount: report.stateDistribution.counts.remembered ?? 0,
    defaultCount: report.stateDistribution.counts.default ?? 0,
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

function buildFallbackDreamNarrative(
  report: DreamsReport,
  actions: DreamsAction[],
  context?: DreamsEngramContext,
): string {
  const name = context?.agentName || 'the agent';
  const forgetCount = actions.filter((a) => a.action === 'forget').length;
  const mergeCount = actions.filter((a) => a.action === 'merge').length;
  const rewriteCount = actions.filter((a) => a.action === 'rewrite_content' || a.action === 'rewrite_thread').length;

  const fragments: string[] = [];
  if (forgetCount > 0) fragments.push(`${forgetCount} dissolving into mist`);
  if (mergeCount > 0) fragments.push(`${mergeCount} fusing where they overlapped`);
  if (rewriteCount > 0) fragments.push(`${rewriteCount} reshaped underfoot`);
  const reshaping = fragments.length > 0
    ? fragments.join(', ')
    : 'the terrain holding steady where it was already quiet';

  return `The dreamscape held ${report.stateDistribution.total} memories across ${report.threadHealth.totalCount} pathways. I moved through ${name}'s vault — ${reshaping}. The dream passed without the Dreamer's voice, only the reshaping remains.`;
}

const DREAMS_SESSION_ID = 'dreams';

/**
 * Write a scratch entry when a Dream starts, so an interrupted dream
 * is visible as an unmatched start without an end.
 */
export async function writeDreamStartEntry(
  manager: MemoryManager,
): Promise<void> {
  await manager.appendScratch(
    DREAMS_SESSION_ID,
    '[DREAM START] Falling asleep... vault analysis and consolidation beginning.',
  );
}

/**
 * Write scratch entries after a Dream completes: the dream narrative
 * (from the LLM) and a structured end entry with stats + reflection prompt.
 */
export async function writeDreamScratchEntry(
  manager: MemoryManager,
  execution: DreamsExecutionResult,
  actions: DreamsAction[],
  report: DreamsReport,
  dream?: string,
): Promise<void> {
  // The dream narrative — always write one, with fallback if the model didn't produce one
  const narrative = dream || 'The dream passed without leaving an impression — only the actions remain.';
  await manager.appendScratch(DREAMS_SESSION_ID, `[DREAMING] ${narrative}`);

  const coreReviewFlags = actions.filter(
    (action): action is Extract<DreamsAction, { action: 'flag_core_review' }> =>
      action.action === 'flag_core_review',
  );
  if (coreReviewFlags.length > 0) {
    const followUps = coreReviewFlags
      .map((flag) => `${flag.path} -> ${flag.concern} Suggested: ${flag.suggested_change}`)
      .join(' | ');
    await manager.appendScratch(DREAMS_SESSION_ID, `[DREAM STATE] Core review for next Fragment: ${followUps}`);
  }

  // Structured end entry
  const actionBreakdown = summarizeActions(actions);
  const lines = [
    `[DREAM END] ${execution.applied} actions applied, ${execution.skipped} skipped.`,
    `Vault: ${report.stateDistribution.total} memories (${report.stateDistribution.counts.remembered ?? 0} remembered, ${report.stateDistribution.counts.default ?? 0} default).`,
    actionBreakdown.length > 0 ? `Actions: ${actionBreakdown.join('; ')}.` : '',
  ].filter(Boolean).join(' | ');

  await manager.appendScratch(DREAMS_SESSION_ID, lines);
}

function summarizeActions(actions: DreamsAction[]): string[] {
  const counts = new Map<string, number>();
  for (const action of actions) {
    counts.set(action.action, (counts.get(action.action) ?? 0) + 1);
  }
  return [...counts.entries()].map(([action, count]) => `${count} ${action}`);
}

function buildDreamRunId(): string {
  return `dream-${new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z')}`;
}

const MIN_DREAM_COMPLETION_TOKENS = 8_000;
const MAX_DREAM_COMPLETION_TOKENS = 32_000;
const PROMPT_TO_COMPLETION_RATIO = 0.5;

/**
 * Estimate an appropriate maxTokens for a Dreams completion based on the
 * prompt size. Uses gpt-tokenizer (via ContextBuilder) to count prompt
 * tokens, then scales completion budget proportionally.
 *
 * Formula: clamp(promptTokens × 0.5, 8 000, 32 000)
 */
export function estimateDreamMaxTokens(messages: DreamsMessage[]): number {
  const estimator = new ContextBuilder();
  const promptTokens = messages.reduce(
    (sum, m) => sum + estimator.estimateTokens(m.content),
    0,
  );
  return Math.max(
    MIN_DREAM_COMPLETION_TOKENS,
    Math.min(MAX_DREAM_COMPLETION_TOKENS, Math.ceil(promptTokens * PROMPT_TO_COMPLETION_RATIO)),
  );
}
