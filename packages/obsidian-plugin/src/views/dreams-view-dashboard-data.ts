import {
  ThreadStatus,
  type ScratchEntry,
  type VaultNote,
} from '@interwebalchemy/engram-core';
import { DreamsAnalyzer } from '../../../dreams/src/analyzer';
import { readDreamsRunHistory } from '../../../dreams/src/history';
import type {
  DreamsReport,
  DreamsRunHistory,
} from '../../../dreams/src/types';
import { SnapshotManager } from '../../../snapshot/src/manager';
import type EngramPlugin from '../main';
import {
  buildGlobalInboxInfo,
  buildThreadInfo,
  colorForThread,
} from './dreams-view-summary-builders';
import type { GlobalInboxInfo, ThreadInfo } from './donut-chart';

export interface ThreadChartData {
  globalInbox: GlobalInboxInfo;
  resolvedThreadId: string | null;
  threads: ThreadInfo[];
}

export interface DashboardData {
  report: DreamsReport;
  snapshotCount: number;
  memoryNotes: VaultNote[];
  soulNote: VaultNote | null;
  scratchEntries: ScratchEntry[];
  threadData: ThreadChartData;
  history: DreamsRunHistory | null;
}

export async function loadDashboardData(
  plugin: EngramPlugin,
  options: { includeHistory?: boolean } = {},
): Promise<DashboardData> {
  const { includeHistory = true } = options;
  const analyzer = new DreamsAnalyzer(plugin.memoryManager);
  const snapshotManager = new SnapshotManager();
  const basePath = plugin.getVaultBasePath();

  const historyPromise = includeHistory
    ? readDreamsRunHistory(plugin.fileAdapter, basePath, plugin.settings.engramRoot, 'working')
    : Promise.resolve<DreamsRunHistory | null>(null);

  const [report, snapshots, notes, soul, scratch, history, threadData] = await Promise.all([
    analyzer.analyze(),
    snapshotManager.list(),
    plugin.memoryManager.list(),
    plugin.memoryManager.getSoulDocument().catch(() => null),
    plugin.memoryManager.readScratch().catch((): ScratchEntry[] => []),
    historyPromise,
    loadThreadData(plugin, basePath),
  ]);

  return {
    report,
    snapshotCount: snapshots.length,
    memoryNotes: notes,
    soulNote: soul,
    scratchEntries: scratch,
    threadData,
    history,
  };
}

export async function loadMemoryArtifacts(plugin: EngramPlugin): Promise<{
  memoryNotes: VaultNote[];
  soulNote: VaultNote | null;
  scratchEntries: ScratchEntry[];
  threadData: ThreadChartData;
}> {
  const basePath = plugin.getVaultBasePath();
  const [notes, soul, scratch, threadData] = await Promise.all([
    plugin.memoryManager.list(),
    plugin.memoryManager.getSoulDocument().catch(() => null),
    plugin.memoryManager.readScratch().catch((): ScratchEntry[] => []),
    loadThreadData(plugin, basePath),
  ]);
  return { memoryNotes: notes, soulNote: soul, scratchEntries: scratch, threadData };
}

async function loadThreadData(plugin: EngramPlugin, basePath: string): Promise<ThreadChartData> {
  const resolvedThreadId = await resolveActiveThreadId(plugin, basePath);
  const [threads, globalInboxItems, globalInboxSummary] = await Promise.all([
    plugin.memoryManager.listThreads().catch((): VaultNote[] => []),
    plugin.memoryManager.listGlobalInbox().catch(() => []),
    plugin.memoryManager.getGlobalInboxSummary(resolvedThreadId ?? undefined).catch(() => null),
  ]);

  const orderedThreads = [...threads].sort((a, b) => {
    const aResolved = readThreadId(a) === resolvedThreadId ? 1 : 0;
    const bResolved = readThreadId(b) === resolvedThreadId ? 1 : 0;
    if (aResolved !== bResolved) {
      return bResolved - aResolved;
    }
    return Date.parse(readThreadUpdated(b)) - Date.parse(readThreadUpdated(a));
  });

  const slices = await Promise.all(orderedThreads.map(async (thread) => {
    const threadId = readThreadId(thread);
    const [inboxItems, threadInboxSummary] = await Promise.all([
      threadId.length > 0 ? plugin.memoryManager.listThreadInbox(threadId).catch(() => []) : Promise.resolve([]),
      threadId.length > 0 ? plugin.memoryManager.getThreadInboxSummary(threadId).catch(() => null) : Promise.resolve(null),
    ]);
    return buildThreadInfo({
      color: colorForThread(threadId),
      inboxItems,
      thread,
      threadId: threadId.length > 0 ? threadId : null,
      threadInboxSummary,
    });
  }));

  return {
    globalInbox: buildGlobalInboxInfo({
      items: globalInboxItems,
      summary: globalInboxSummary,
    }),
    resolvedThreadId,
    threads: slices.filter((thread) => thread.threadId.length > 0 && thread.storedCount > 0),
  };
}

async function resolveActiveThreadId(plugin: EngramPlugin, basePath: string): Promise<string | null> {
  try {
    const resolved = await plugin.memoryManager.resolveThread({
      cwd: basePath.length > 0 ? basePath : undefined,
      autoCreate: false,
    });
    return resolved.threadId;
  } catch {
    const fallback = await loadFallbackThread(plugin);
    return fallback?.threadId ?? null;
  }
}

async function loadFallbackThread(
  plugin: EngramPlugin,
): Promise<{ threadId: string; thread: VaultNote } | null> {
  const threads = await plugin.memoryManager.listThreads().catch((): VaultNote[] => []);
  const fallback = [...threads]
    .filter((thread) =>
      thread.frontmatter.status === ThreadStatus.Active || thread.frontmatter.status === ThreadStatus.Paused)
    .sort((a, b) => Date.parse(readThreadUpdated(b)) - Date.parse(readThreadUpdated(a)))
    .at(0) ?? null;

  if (fallback === null) {
    return null;
  }

  const threadId = readThreadId(fallback);
  return threadId.length > 0 ? { thread: fallback, threadId } : null;
}

function readThreadUpdated(thread: VaultNote): string {
  return typeof thread.frontmatter.updated === 'string'
    ? thread.frontmatter.updated
    : '';
}

function readThreadId(thread: VaultNote): string {
  return typeof thread.frontmatter.thread_id === 'string'
    ? thread.frontmatter.thread_id
    : '';
}
