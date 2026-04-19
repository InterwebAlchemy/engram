import {
  MemoryState,
  MemoryType,
  type VaultNote,
} from '@interwebalchemy/engram-core';
import type { DreamsReport } from '../../../dreams/src/types';
import { renderDonutChart, type DonutChartData } from './donut-chart';

/* ─── Constants ──────────────────────────────────────────────────────────── */

const APPROX_CHARS_PER_TOKEN = 4;
const HOURS_PER_DAY = 24;
const MILLISECONDS_PER_SECOND = 1000;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const STALE_FORGOTTEN_MAX_AGE_DAYS = 21;
const MILLISECONDS_PER_DAY =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

const STATE_ORDER = [
  MemoryState.Core,
  MemoryState.Remembered,
  MemoryState.Default,
  MemoryState.Forgotten,
] as const;
const TYPE_ORDER = [
  MemoryType.Fact,
  MemoryType.Entity,
  MemoryType.Reflection,
  'other',
] as const;
const STATE_META = {
  [MemoryState.Core]: {
    color: 'var(--engram-state-core)',
    label: 'Core',
  },
  [MemoryState.Remembered]: {
    color: 'var(--engram-state-remembered)',
    label: 'Remembered',
  },
  [MemoryState.Default]: {
    color: 'var(--engram-state-default)',
    label: 'Default',
  },
  [MemoryState.Forgotten]: {
    color: 'var(--engram-state-forgotten)',
    label: 'Forgotten',
  },
} satisfies Record<MemoryState, { color: string; label: string }>;
const TYPE_META: Record<string, { color: string; label: string }> = {
  [MemoryType.Fact]: {
    color: 'var(--engram-type-fact)',
    label: 'Facts',
  },
  [MemoryType.Entity]: {
    color: 'var(--engram-type-entity)',
    label: 'Entities',
  },
  [MemoryType.Reflection]: {
    color: 'var(--engram-type-reflection)',
    label: 'Reflections',
  },
  other: {
    color: 'var(--engram-type-other)',
    label: 'Other',
  },
};
const TYPE_COLOR_BY_LABEL: Record<string, string> = {};
for (const { label, color } of Object.values(TYPE_META)) {
  TYPE_COLOR_BY_LABEL[label] = color;
}

/* ─── Interfaces ─────────────────────────────────────────────────────────── */

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

interface TypeBreakdown {
  color: string;
  count: number;
  label: string;
}

interface StateBreakdown {
  color: string;
  count: number;
  label: string;
  types: TypeBreakdown[];
}

interface SummaryData {
  approxTokens: number;
  bootstrapCount: number;
  bootstrapTokens: number;
  dreamTargetCount: number;
  napReclaimCount: number;
  queueGroups: QueueGroup[];
  snapshots: number;
  stateBreakdown: StateBreakdown[];
  threads: number;
  tokenBreakdown: StateBreakdown[];
  totalMemories: number;
}

export function renderSummarySection(
  parent: HTMLElement,
  report: DreamsReport,
  snapshotCount: number,
  memoryNotes: VaultNote[],
): void {
  const data = buildSummaryData(report, snapshotCount, memoryNotes);

  const card = parent.createDiv({ cls: 'engram-dreams-storage-card' });
  const body = card.createDiv({ cls: 'engram-dreams-storage-body' });
  renderChart(body, data);

  renderHealthBar(parent, data);
  renderMaintenanceQueue(parent, data);
}

function renderHealthBar(parent: HTMLElement, data: SummaryData): void {
  const bar = parent.createDiv({ cls: 'engram-overview-health' });
  renderHealthStat(bar, formatCount(data.totalMemories), 'memories');
  renderHealthStat(bar, formatCount(data.approxTokens), 'est. tokens');
  renderHealthStat(bar, formatCount(data.threads), 'threads');
  renderHealthStat(bar, formatCount(data.snapshots), 'snapshots');
}

function renderHealthStat(parent: HTMLElement, value: string, label: string): void {
  const stat = parent.createDiv({ cls: 'engram-overview-health-stat' });
  stat.createDiv({ cls: 'engram-overview-health-value', text: value });
  stat.createDiv({ cls: 'engram-overview-health-label', text: label });
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
  const chartData: DonutChartData = {
    bootstrapCount: data.bootstrapCount,
    bootstrapTokens: data.bootstrapTokens,
    centerLabel: isTokens ? 'est. tokens' : 'memories',
    centerValue: isTokens ? data.approxTokens : data.totalMemories,
    dreamTargetCount: data.dreamTargetCount,
    napReclaimCount: data.napReclaimCount,
    stateBreakdown: isTokens ? data.tokenBreakdown : data.stateBreakdown,
    typeColorByLabel: TYPE_COLOR_BY_LABEL,
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

function buildSummaryData(
  report: DreamsReport,
  snapshotCount: number,
  memoryNotes: VaultNote[],
): SummaryData {
  const breakdown = buildStateBreakdown(memoryNotes);

  const staleForgotten = countStaleForgotten(report);
  const {
    mergeCandidates,
    scratchHealth,
    stateDistribution: {
      counts: {
        core: coreCount,
        remembered: rememberedCount,
      },
    },
    threadHealth,
  } = report;
  const { oversizedThreads } = threadHealth;
  const { staleSessions } = scratchHealth;
  const { length: oversizedThreadCount } = oversizedThreads;
  const { length: mergeCandidateCount } = mergeCandidates;
  const { length: staleScratchSessionCount } = staleSessions;
  const napReclaimCount =
    staleForgotten +
    oversizedThreadCount +
    mergeCandidateCount +
    staleScratchSessionCount;
  const dreamTargetCount =
    report.dataQualityIssues.length +
    report.threadCoverageGaps.length +
    report.scratchThreadCandidates.filter((candidate) => candidate.candidateThreadId === null).length;

  const bootstrapCount = coreCount + rememberedCount;
  const bootstrapNotes = memoryNotes.filter(
    (note) => note.frontmatter.memory_state === MemoryState.Core || note.frontmatter.memory_state === MemoryState.Remembered,
  );

  return {
    approxTokens: estimateMemoryTokens(memoryNotes),
    bootstrapCount,
    bootstrapTokens: estimateMemoryTokens(bootstrapNotes),
    dreamTargetCount,
    napReclaimCount,
    queueGroups: [
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
    ],
    snapshots: snapshotCount,
    stateBreakdown: breakdown,
    threads: report.threadHealth.totalCount,
    tokenBreakdown: buildTokenBreakdown(memoryNotes),
    totalMemories: report.stateDistribution.total,
  };
}

function buildStateBreakdown(memoryNotes: VaultNote[]): StateBreakdown[] {
  const counts = createStateTypeCounts();
  for (const note of memoryNotes) {
    const state = normalizeMemoryState(note.frontmatter.memory_state);
    const type = normalizeMemoryType(note.frontmatter.type);
    counts[state][type] += 1;
  }

  return stateCountsToBreakdown(counts);
}

function buildTokenBreakdown(memoryNotes: VaultNote[]): StateBreakdown[] {
  const counts = createStateTypeCounts();
  for (const note of memoryNotes) {
    const state = normalizeMemoryState(note.frontmatter.memory_state);
    const type = normalizeMemoryType(note.frontmatter.type);
    counts[state][type] += estimateNoteTokens(note);
  }

  return stateCountsToBreakdown(counts);
}

function stateCountsToBreakdown(
  counts: Record<MemoryState, Record<string, number>>,
): StateBreakdown[] {
  return STATE_ORDER.map((state) => {
    const types = TYPE_ORDER
      .map((type) => ({
        color: TYPE_META[type].color,
        count: counts[state][type],
        label: TYPE_META[type].label,
      }))
      .filter((type) => type.count > 0);
    return {
      color: STATE_META[state].color,
      count: types.reduce((sum, type) => sum + type.count, 0),
      label: STATE_META[state].label,
      types,
    };
  });
}

function createStateTypeCounts(): Record<MemoryState, Record<string, number>> {
  return {
    [MemoryState.Core]: createTypeCounts(),
    [MemoryState.Remembered]: createTypeCounts(),
    [MemoryState.Default]: createTypeCounts(),
    [MemoryState.Forgotten]: createTypeCounts(),
  };
}

function createTypeCounts(): Record<string, number> {
  return {
    [MemoryType.Fact]: 0,
    [MemoryType.Entity]: 0,
    [MemoryType.Reflection]: 0,
    other: 0,
  };
}

function normalizeMemoryState(value: unknown): MemoryState {
  switch (value) {
    case MemoryState.Core:
    case MemoryState.Remembered:
    case MemoryState.Forgotten:
      return value;
    case MemoryState.Default:
    default:
      return MemoryState.Default;
  }
}

function normalizeMemoryType(value: unknown): string {
  switch (value) {
    case MemoryType.Fact:
    case MemoryType.Entity:
    case MemoryType.Reflection:
      return value;
    default:
      return 'other';
  }
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

function estimateNoteTokens(note: VaultNote): number {
  return Math.ceil(note.content.trim().length / APPROX_CHARS_PER_TOKEN);
}

function estimateMemoryTokens(memoryNotes: VaultNote[]): number {
  return memoryNotes.reduce((sum, note) => sum + estimateNoteTokens(note), 0);
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
