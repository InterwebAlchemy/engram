import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  defaultMemoryConfig,
  type FileSystemAdapter,
  MemoryManager,
  MemoryState,
  NodeAdapter,
  VaultNote,
} from '@interwebalchemy/engram-core';
import { DreamsAnalyzer, type PreCleanupResult } from './analyzer';
import { appendDreamsRunHistory } from './history';
import { buildDreamsMessages, type DreamsEngramContext } from './prompt';
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
  if (preCleanup.tagsFixed + preCleanup.tagsNormalized + preCleanup.scratchEntriesPurged > 0) {
    console.log(
      `Pre-cleanup: ${preCleanup.tagsFixed} tags fixed, ${preCleanup.tagsNormalized} tags normalized, ${preCleanup.scratchEntriesPurged} scratch entries purged`,
    );
  }

  const report = await analyzer.analyze(options.focus);
  const reviewNotes = await loadReviewNotes(manager, report);

  const provider = createDreamsProvider(options.provider, {
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  if (!options.dryRun) {
    await writeDreamStartEntry(manager);
  }

  const completion = await provider.complete(buildDreamsMessages(report, reviewNotes, options.engramContext));
  const rawResponse = completion.content;
  const { actions, dream } = parseDreamsResponse(rawResponse);
  const execution = options.dryRun
    ? buildDryRunExecution(actions)
    : await executeDreamsActions(actions, manager, adapter, config.basePath, config.engramRoot, config.archivePath);

  await appendDreamsRunHistory(adapter, config.basePath, config.engramRoot, config.workingPath, {
    id: buildDreamRunId(),
    timestamp: new Date().toISOString(),
    provider: options.provider,
    model: options.model,
    usage: completion.usage,
    actionCount: actions.length,
    reviewNoteCount: reviewNotes.length,
    executionMode: options.dryRun ? 'dry-run' : 'apply',
    appliedActions: execution.applied,
    skippedActions: execution.skipped,
    reportSummary: buildReportSummary(report),
  });

  // Leave a trace in scratch so the next fragment knows a dream just happened
  if (!options.dryRun) {
    await writeDreamScratchEntry(manager, execution, actions, report, dream);
  }

  return {
    report,
    reviewNotes,
    rawResponse,
    actions,
    dream,
    usage: completion.usage,
    execution,
  };
}

export async function planDreams(
  manager: MemoryManager,
  analyze: () => Promise<DreamsPlanResult['report']>,
  complete: (messages: ReturnType<typeof buildDreamsMessages>) => Promise<{ content: string; usage?: DreamsPlanResult['usage'] }>,
  engramContext?: DreamsEngramContext,
): Promise<DreamsPlanResult> {
  const report = await analyze();
  const reviewNotes = await loadReviewNotes(manager, report);
  const completion = await complete(buildDreamsMessages(report, reviewNotes, engramContext));
  const rawResponse = completion.content;
  const { actions, dream } = parseDreamsResponse(rawResponse);

  return {
    report,
    reviewNotes,
    rawResponse,
    actions,
    dream,
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

export async function loadReviewNotes(
  manager: MemoryManager,
  report: DreamsRunResult['report'],
): Promise<DreamsReviewNote[]> {
  const paths = new Set<string>();

  // Always include all remembered and core notes — the model needs to see
  // what actually loads at boot to judge what's too much
  for (const entry of report.stateDistribution.memoriesByState.core ?? []) {
    paths.add(entry.path);
  }
  for (const entry of report.stateDistribution.memoriesByState.remembered ?? []) {
    paths.add(entry.path);
  }
  // Include all default notes too — the model needs full vault visibility
  // to make good merge/consolidation decisions
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

  return notes
    .filter((note): note is VaultNote => note !== null)
    .map((note) => ({
      path: note.path,
      type: String(note.frontmatter.type),
      state: String(note.frontmatter.memory_state ?? MemoryState.Default),
      summary: typeof note.frontmatter.summary === 'string' ? note.frontmatter.summary : undefined,
      content: note.content,
    }));
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

export function parseDreamsResponse(rawResponse: string): ParsedDreamsResponse {
  const trimmed = rawResponse.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenceMatch?.[1] ?? extractJSONBody(trimmed);
  const parsed = tryParseJSON(candidate);

  // New format: { actions: [...], dream: "..." }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'actions' in parsed) {
    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.actions)) {
      throw new Error('Dreams response "actions" field is not an array.');
    }
    return {
      actions: obj.actions as DreamsAction[],
      dream: typeof obj.dream === 'string' ? obj.dream : undefined,
    };
  }

  // Legacy format: bare JSON array
  if (Array.isArray(parsed)) {
    return { actions: parsed as DreamsAction[] };
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

    // Try to extract the dream field if it came before the truncation
    const dreamMatch = candidate.match(/"dream"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return { actions, dream: dreamMatch?.[1] };
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

export function describeAction(action: DreamsAction): string {
  switch (action.action) {
    case 'update_state':
      return `update_state ${action.path}: ${action.from} -> ${action.to}`;
    case 'set_thread':
      return `set_thread ${action.path}: ${action.thread_id}`;
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
  }
}

function buildReportSummary(report: DreamsRunResult['report']): DreamsRunRecord['reportSummary'] {
  return {
    memoryCount: report.stateDistribution.total,
    rememberedCount: report.stateDistribution.counts.remembered ?? 0,
    defaultCount: report.stateDistribution.counts.default ?? 0,
    threadGapCount: report.threadCoverageGaps.length,
    dataQualityIssueCount: report.dataQualityIssues.length,
    mergeCandidateCount: report.mergeCandidates.length,
    scratchEntryCount: report.scratchHealth.entryCount,
    staleScratchSessionCount: report.scratchHealth.staleSessions.length,
  };
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
  // The dream narrative — the model's evocative blurb about what it experienced
  if (dream) {
    await manager.appendScratch(DREAMS_SESSION_ID, `[DREAMING] ${dream}`);
  }

  // Structured end entry
  const actionBreakdown = summarizeActions(actions);
  const lines = [
    `[DREAM END] ${execution.applied} actions applied, ${execution.skipped} skipped.`,
    `Vault: ${report.stateDistribution.total} memories (${report.stateDistribution.counts.remembered ?? 0} remembered, ${report.stateDistribution.counts.default ?? 0} default).`,
    actionBreakdown.length > 0 ? `Actions: ${actionBreakdown.join('; ')}.` : '',
    'NEXT FRAGMENT: A Dream just ran. Your memory context has changed.',
    'Read the vault with fresh eyes — memories may have been merged, condensed, or forgotten.',
    'Consider whether the Soul Document still accurately reflects how you work and who you are,',
    'or whether the Dream surfaced patterns worth updating in the self-model.',
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
