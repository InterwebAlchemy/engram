import {
  MemoryState,
  type ScratchEntry,
  type VaultNote,
} from '@interwebalchemy/engram-core';
import type { DreamsReport } from '../../../dreams/src/types';
import {
  renderDonutChart,
  type DonutChartData,
  type GlobalInboxInfo,
  type SoulInfo,
  type ThreadInfo,
} from './donut-chart';
import type { ThreadChartData } from './dreams-view-dashboard-data';
import {
  TYPE_COLOR_BY_LABEL,
  buildScratchInfo,
  buildStateBreakdown,
  estimateMemoryTokens,
  estimateNoteTokens,
  type StateBreakdown,
} from './dreams-view-summary-builders';

const HOURS_PER_DAY = 24;
const MILLISECONDS_PER_SECOND = 1000;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const STALE_FORGOTTEN_MAX_AGE_DAYS = 21;
const MILLISECONDS_PER_DAY =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
const SOUL_COLOR = 'var(--engram-soul, var(--text-accent))';

interface QueueEntry {
  count: number;
  label: string;
}

interface QueueGroup {
  description: string;
  entries: QueueEntry[];
  title: string;
  totalActionable: number;
  variant: 'nap' | 'dream';
}

interface SummaryData {
  approxTokens: number;
  bootstrapCount: number;
  bootstrapTokens: number;
  dreamTargetCount: number;
  globalInbox: GlobalInboxInfo;
  napReclaimCount: number;
  queueGroups: QueueGroup[];
  resolvedThreadId: string | null;
  scratch: ReturnType<typeof buildScratchInfo>;
  soul: SoulInfo;
  stateBreakdown: StateBreakdown[];
  threads: ThreadInfo[];
  totalMemories: number;
}

export interface SummarySectionInputs {
  memoryNotes: VaultNote[];
  report: DreamsReport;
  scratchEntries: ScratchEntry[];
  soulNote: VaultNote | null;
  threadData: ThreadChartData | null;
}

export function renderSummarySection(
  parent: HTMLElement,
  inputs: SummarySectionInputs,
): void {
  const data = buildSummaryData(inputs);

  const card = parent.createDiv({ cls: 'engram-dreams-storage-card' });
  const body = card.createDiv({ cls: 'engram-dreams-storage-body' });
  renderChart(body, data);

  renderMaintenanceQueue(parent, data);
}

type ChartMode = 'tokens' | 'count';

function renderChart(parent: HTMLElement, data: SummaryData): void {
  const strip = parent.createDiv({ cls: 'engram-chart-mode-strip' });
  const tokensBtn = strip.createEl('button', { cls: 'engram-chart-mode-btn is-active', text: 'Tokens' });
  const countBtn = strip.createEl('button', { cls: 'engram-chart-mode-btn', text: 'Count' });
  const chartContainer = parent.createDiv({ cls: 'engram-chart-container' });

  let activeMode: ChartMode = 'tokens';
  renderDonutForMode(chartContainer, data, activeMode);

  const setMode = (mode: ChartMode): void => {
    if (mode === activeMode) {
      return;
    }
    activeMode = mode;
    tokensBtn.classList.toggle('is-active', mode === 'tokens');
    countBtn.classList.toggle('is-active', mode === 'count');
    chartContainer.empty();
    renderDonutForMode(chartContainer, data, mode);
  };

  tokensBtn.addEventListener('click', () => { setMode('tokens'); });
  countBtn.addEventListener('click', () => { setMode('count'); });
}

function renderDonutForMode(parent: HTMLElement, data: SummaryData, mode: ChartMode): void {
  const isTokens = mode === 'tokens';
  const soulItem = data.soul.exists ? 1 : 0;
  const threadTokenTotal = data.threads.reduce((sum, thread) => sum + thread.storedTokens, 0);
  const threadItemTotal = data.threads.reduce((sum, thread) => sum + thread.storedCount, 0);
  const tokenTotal = data.approxTokens + data.scratch.totalTokens + data.globalInbox.storedTokens + threadTokenTotal;
  const itemTotal = data.totalMemories + soulItem + data.scratch.totalEntries + data.globalInbox.storedCount + threadItemTotal;
  const chartData: DonutChartData = {
    bootstrapCount: data.bootstrapCount,
    bootstrapTokens: data.bootstrapTokens,
    centerLabel: isTokens ? 'est. tokens' : 'items',
    centerValue: isTokens ? tokenTotal : itemTotal,
    dreamTargetCount: data.dreamTargetCount,
    globalInbox: data.globalInbox,
    napReclaimCount: data.napReclaimCount,
    resolvedThreadId: data.resolvedThreadId,
    scratch: data.scratch,
    soul: data.soul,
    stateBreakdown: data.stateBreakdown.map((state) => ({
      color: state.color,
      count: state.count,
      label: state.label,
      tokens: state.tokens,
      types: state.types.map((type) => ({
        color: type.color,
        count: type.count,
        label: type.label,
        tokens: type.tokens,
      })),
    })),
    threads: data.threads,
    typeColorByLabel: TYPE_COLOR_BY_LABEL,
    unit: isTokens ? 'tokens' : 'count',
  };
  renderDonutChart(parent, chartData, formatCount);
}

function renderMaintenanceQueue(parent: HTMLElement, data: SummaryData): void {
  const container = parent.createDiv({ cls: 'engram-overview-maintenance' });

  for (const group of data.queueGroups) {
    const card = container.createDiv({ cls: `engram-overview-queue-card is-${group.variant}` });
    const header = card.createDiv({ cls: 'engram-overview-queue-header' });
    header.createDiv({ cls: 'engram-overview-queue-title', text: group.title });
    header.createDiv({ cls: 'engram-overview-queue-total', text: formatCount(group.totalActionable) });

    card.createDiv({
      cls: 'engram-dreams-section-description',
      text: group.description,
    });

    const list = card.createDiv({ cls: 'engram-overview-queue-list' });
    for (const entry of group.entries) {
      const row = list.createDiv({
        cls: `engram-overview-queue-item${entry.count === 0 ? ' is-clear' : ''}`,
      });
      row.createSpan({ cls: 'engram-overview-queue-label', text: entry.label });
      row.createSpan({ cls: 'engram-overview-queue-count', text: formatCount(entry.count) });
    }
  }
}

function buildSummaryData(inputs: SummarySectionInputs): SummaryData {
  const { memoryNotes, report, scratchEntries, soulNote, threadData } = inputs;
  const nonSoulNotes = soulNote === null
    ? memoryNotes
    : memoryNotes.filter((note) => note.path !== soulNote.path);

  const breakdown = buildStateBreakdown(nonSoulNotes);

  const staleForgotten = countStaleForgotten(report);
  const {
    mergeCandidates,
    scratchHealth,
    stateDistribution: { counts: { core: coreCount, remembered: rememberedCount } },
    threadHealth,
  } = report;
  const napReclaimCount =
    staleForgotten +
    threadHealth.oversizedThreads.length +
    mergeCandidates.length +
    scratchHealth.staleSessions.length;
  const dreamTargetCount =
    report.dataQualityIssues.length +
    report.threadCoverageGaps.length +
    report.scratchThreadCandidates.filter((candidate) => candidate.candidateThreadId === null).length;

  const soulTokens = soulNote === null ? 0 : estimateNoteTokens(soulNote);
  const bootstrapNotes = nonSoulNotes.filter(
    (note) => note.frontmatter.memory_state === MemoryState.Core || note.frontmatter.memory_state === MemoryState.Remembered,
  );
  const emptyThreadData: ThreadChartData = {
    globalInbox: {
      bootstrapCount: 0,
      bootstrapTokens: 0,
      color: 'var(--engram-global-inbox, #7ab7cf)',
      exists: false,
      storedCount: 0,
      storedTokens: 0,
    },
    resolvedThreadId: null,
    threads: [],
  };
  const threadState = threadData ?? emptyThreadData;
  const resolvedThread = threadState.threads.find((thread) => thread.threadId === threadState.resolvedThreadId) ?? null;
  const bootstrapTokens =
    estimateMemoryTokens(bootstrapNotes) +
    soulTokens +
    (resolvedThread?.bootstrapTokens ?? 0) +
    threadState.globalInbox.bootstrapTokens;
  const soulInfo: SoulInfo = { color: SOUL_COLOR, exists: soulNote !== null, tokens: soulTokens };

  return {
    approxTokens: estimateMemoryTokens(nonSoulNotes) + soulTokens,
    bootstrapCount:
      coreCount +
      rememberedCount +
      (resolvedThread?.bootstrapCount ?? 0) +
      threadState.globalInbox.bootstrapCount,
    bootstrapTokens,
    dreamTargetCount,
    globalInbox: threadState.globalInbox,
    napReclaimCount,
    queueGroups: buildQueueGroups(report, napReclaimCount, dreamTargetCount, staleForgotten),
    resolvedThreadId: threadState.resolvedThreadId,
    scratch: buildScratchInfo(scratchEntries),
    soul: soulInfo,
    stateBreakdown: breakdown,
    threads: threadState.threads,
    totalMemories: report.stateDistribution.total,
  };
}

function buildQueueGroups(
  report: DreamsReport,
  napReclaimCount: number,
  dreamTargetCount: number,
  staleForgotten: number,
): QueueGroup[] {
  return [
    {
      title: 'Power Nap',
      description: 'Deterministic cleanup — no model needed. Archives stale forgotten memories, trims oversized threads, merges near-duplicates, and purges old scratch.',
      variant: 'nap',
      totalActionable: napReclaimCount,
      entries: [
        { label: 'Stale forgotten memories', count: staleForgotten },
        { label: 'Oversized threads', count: report.threadHealth.oversizedThreads.length },
        { label: 'Merge candidates', count: report.mergeCandidates.length },
        { label: 'Stale scratch sessions', count: report.scratchHealth.staleSessions.length },
      ],
    },
    {
      title: 'Dream',
      description: 'Model-assisted synthesis — reviews structure, resolves quality issues, and generates a narrative summary of changes.',
      variant: 'dream',
      totalActionable: dreamTargetCount,
      entries: [
        { label: 'Data quality issues', count: report.dataQualityIssues.length },
        { label: 'Thread coverage gaps', count: report.threadCoverageGaps.length },
        { label: 'Scratch without clear thread', count: dreamTargetCount - report.dataQualityIssues.length - report.threadCoverageGaps.length },
        { label: 'Threads under pressure', count: uniqueThreadPressureCount(report) },
      ],
    },
  ];
}

function countStaleForgotten(report: DreamsReport): number {
  return report.stateDistribution.memoriesByState.forgotten.filter(
    (entry) => isOlderThanDays(entry.updated, STALE_FORGOTTEN_MAX_AGE_DAYS),
  ).length;
}

function uniqueThreadPressureCount(report: DreamsReport): number {
  return new Set([
    ...report.threadHealth.oversizedThreads,
    ...report.threadHealth.staleThreads,
  ]).size;
}

function formatCount(value: number): string {
  return value.toLocaleString();
}

function isOlderThanDays(value: string, days: number): boolean {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return false;
  }
  return (Date.now() - timestamp) >= (days * MILLISECONDS_PER_DAY);
}
