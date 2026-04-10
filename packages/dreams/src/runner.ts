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
import { DreamsAnalyzer } from './analyzer';
import { appendDreamsRunHistory } from './history';
import { buildDreamsMessages } from './prompt';
import { createDreamsProvider } from './providers';
import type {
  DreamsAction,
  DreamsExecutionResult,
  DreamsPlanResult,
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

  const report = await analyzer.analyze(options.focus);
  const reviewNotes = await loadReviewNotes(manager, report);

  const provider = createDreamsProvider(options.provider, {
    model: options.model,
    apiKey: options.apiKey,
    baseURL: options.baseURL,
  });

  const completion = await provider.complete(buildDreamsMessages(report, reviewNotes));
  const rawResponse = completion.content;
  const actions = parseDreamsActions(rawResponse);
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

  return {
    report,
    reviewNotes,
    rawResponse,
    actions,
    usage: completion.usage,
    execution,
  };
}

export async function planDreams(
  manager: MemoryManager,
  analyze: () => Promise<DreamsPlanResult['report']>,
  complete: (messages: ReturnType<typeof buildDreamsMessages>) => Promise<{ content: string; usage?: DreamsPlanResult['usage'] }>,
): Promise<DreamsPlanResult> {
  const report = await analyze();
  const reviewNotes = await loadReviewNotes(manager, report);
  const completion = await complete(buildDreamsMessages(report, reviewNotes));
  const rawResponse = completion.content;
  const actions = parseDreamsActions(rawResponse);

  return {
    report,
    reviewNotes,
    rawResponse,
    actions,
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

  for (const entry of report.stateDistribution.memoriesByState.remembered ?? []) {
    paths.add(entry.path);
  }
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

export function parseDreamsActions(rawResponse: string): DreamsAction[] {
  const trimmed = rawResponse.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenceMatch?.[1] ?? extractJSONArray(trimmed);
  const parsed = JSON.parse(candidate) as unknown;

  if (!Array.isArray(parsed)) {
    throw new Error('Dreams provider response was not a JSON array.');
  }

  return parsed as DreamsAction[];
}

function extractJSONArray(text: string): string {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Could not find a JSON array in Dreams provider response.');
  }
  return text.slice(start, end + 1);
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

function buildDreamRunId(): string {
  return `dream-${new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z')}`;
}
