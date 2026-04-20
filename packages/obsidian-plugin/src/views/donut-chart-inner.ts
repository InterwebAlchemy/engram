import type {
  DonutChartData,
  ScratchSession,
  StateSegment,
  ThreadInfo,
  TypeSegment,
} from './donut-chart-types';

const BOOTSTRAP_STATE_LABELS = new Set(['Core', 'Remembered']);
const DEFAULT_STATE_ORDER = ['Core', 'Remembered', 'Default', 'Forgotten'] as const;

export type InnerSegment =
  | {
    bootstrap: boolean;
    bootstrapCount: number;
    bootstrapTokens: number;
    color: string;
    count: number;
    key: string;
    kind: 'global-inbox';
    label: string;
    tokens: number;
  }
  | {
    bootstrap: boolean;
    bootstrapCount: number;
    bootstrapTokens: number;
    color: string;
    count: number;
    key: string;
    kind: 'scratch-bootstrap' | 'scratch-cold';
    label: string;
    sessions: ScratchSession[];
    tokens: number;
  }
  | {
    bootstrap: boolean;
    bootstrapCount: number;
    bootstrapTokens: number;
    color: string;
    count: number;
    isResolved: boolean;
    key: string;
    kind: 'thread';
    label: string;
    threadInboxIncluded: boolean;
    threadId: string;
    tokens: number;
  }
  | {
    bootstrap: boolean;
    bootstrapCount: number;
    bootstrapTokens: number;
    color: string;
    count: number;
    key: string;
    kind: 'soul';
    label: string;
    tokens: number;
  }
  | {
    bootstrap: boolean;
    bootstrapCount: number;
    bootstrapTokens: number;
    color: string;
    count: number;
    key: string;
    kind: 'state';
    label: string;
    tokens: number;
    types: TypeSegment[];
  };

export function buildInnerSegments(data: DonutChartData): InnerSegment[] {
  const statesByLabel = new Map(data.stateBreakdown.map((state) => [state.label, state]));
  const orderedStates = DEFAULT_STATE_ORDER
    .map((label) => statesByLabel.get(label))
    .filter((state): state is StateSegment => state !== undefined && state.count > 0);

  const bootstrapStates = orderedStates.filter((state) => BOOTSTRAP_STATE_LABELS.has(state.label));
  const coldStates = orderedStates.filter((state) => !BOOTSTRAP_STATE_LABELS.has(state.label));

  const segments: InnerSegment[] = [];
  if (data.soul.exists) {
    segments.push({
      bootstrap: true,
      color: data.soul.color,
      count: 1,
      key: 'soul',
      kind: 'soul',
      label: 'Soul',
      bootstrapCount: 1,
      bootstrapTokens: data.soul.tokens,
      tokens: data.soul.tokens,
    });
  }
  if (data.scratch.bootstrapEntries > 0) {
    segments.push({
      bootstrap: true,
      bootstrapCount: data.scratch.bootstrapEntries,
      bootstrapTokens: data.scratch.bootstrapTokens,
      color: data.scratch.color,
      count: data.scratch.bootstrapEntries,
      key: 'scratch-bootstrap',
      kind: 'scratch-bootstrap',
      label: 'Scratch · in bootstrap',
      sessions: data.scratch.sessions,
      tokens: data.scratch.bootstrapTokens,
    });
  }
  if (data.globalInbox.exists) {
    segments.push({
      bootstrap: false,
      bootstrapCount: data.globalInbox.bootstrapCount,
      bootstrapTokens: data.globalInbox.bootstrapTokens,
      color: data.globalInbox.color,
      count: data.globalInbox.storedCount,
      key: 'global-inbox',
      kind: 'global-inbox',
      label: 'Global Inbox',
      tokens: data.globalInbox.storedTokens,
    });
  }
  for (const state of bootstrapStates) {
    segments.push(stateToInnerSegment(state));
  }
  for (const thread of data.threads) {
    segments.push(threadToInnerSegment(thread, data.resolvedThreadId));
  }
  for (const state of coldStates) {
    segments.push(stateToInnerSegment(state));
  }
  if (data.scratch.excludedEntries > 0) {
    segments.push({
      bootstrap: false,
      bootstrapCount: 0,
      bootstrapTokens: 0,
      color: 'var(--engram-scratch-cold, var(--text-faint))',
      count: data.scratch.excludedEntries,
      key: 'scratch-cold',
      kind: 'scratch-cold',
      label: 'Scratch · cold',
      sessions: data.scratch.sessions,
      tokens: data.scratch.excludedTokens,
    });
  }

  return segments;
}

export function getInnerValue(segment: InnerSegment, unit: DonutChartData['unit']): number {
  return unit === 'tokens' ? segment.tokens : segment.count;
}

export function innerLegendLabel(segment: InnerSegment): string {
  if (segment.kind === 'thread') {
    return segment.isResolved ? `Thread · ${segment.label} · current` : `Thread · ${segment.label}`;
  }
  return segment.label;
}

export function innerLegendMeta(formatCount: (value: number) => string, segment: InnerSegment): string {
  if (segment.kind === 'soul') {
    return `1 doc · ~${formatCount(segment.tokens)} tok`;
  }
  if (segment.kind === 'thread' || segment.kind === 'global-inbox') {
    const noun = segment.kind === 'thread' ? 'items' : 'notes';
    const bootstrapMeta = segment.bootstrapTokens > 0
      ? ` · bootstrap ~${formatCount(segment.bootstrapTokens)} tok`
      : '';
    return `${formatCount(segment.count)} ${noun} · ~${formatCount(segment.tokens)} tok stored${bootstrapMeta}`;
  }
  const noun = segment.kind === 'state' ? 'memories' : 'entries';
  return `${formatCount(segment.count)} ${noun} · ~${formatCount(segment.tokens)} tok`;
}

function stateToInnerSegment(state: StateSegment): InnerSegment {
  return {
    bootstrap: BOOTSTRAP_STATE_LABELS.has(state.label),
    bootstrapCount: state.count,
    bootstrapTokens: state.tokens,
    color: state.color,
    count: state.count,
    key: state.label,
    kind: 'state',
    label: state.label,
    tokens: state.tokens,
    types: state.types,
  };
}

function threadToInnerSegment(thread: ThreadInfo, resolvedThreadId: string | null): InnerSegment {
  return {
    bootstrap: false,
    bootstrapCount: thread.bootstrapCount,
    bootstrapTokens: thread.bootstrapTokens,
    color: thread.color,
    count: thread.storedCount,
    isResolved: thread.threadId === resolvedThreadId,
    key: `thread:${thread.threadId}`,
    kind: 'thread',
    label: thread.label,
    threadId: thread.threadId,
    threadInboxIncluded: thread.threadInboxIncluded,
    tokens: thread.storedTokens,
  };
}
