import {
  globalInboxBootstrapTooltipBody,
  threadBootstrapTooltipBody,
} from './donut-chart-legend';
import {
  buildInnerSegments,
  getInnerValue,
  innerLegendLabel,
  type InnerSegment,
} from './donut-chart-inner';
import type { DonutChartData, DonutTarget } from './donut-chart-types';

export function resolveFocusedCenter(
  data: DonutChartData,
  activeTarget: DonutTarget | null,
): { label: string; value: number } {
  if (activeTarget === null) {
    return { label: data.centerLabel, value: data.centerValue };
  }

  if (activeTarget.kind === 'bootstrap') {
    return {
      label: `Bootstrap · ${data.centerLabel}`,
      value: data.unit === 'tokens'
        ? data.bootstrapTokens + data.scratch.bootstrapTokens
        : data.bootstrapCount + data.scratch.bootstrapEntries,
    };
  }

  const segments = buildInnerSegments(data);
  switch (activeTarget.kind) {
    case 'inner':
      return resolveInnerFocusedCenter(data, segments, activeTarget.key);
    case 'overlay':
      return resolveOverlayFocusedCenter(data, segments, activeTarget.key);
    case 'outer':
      return resolveOuterFocusedCenter(data, activeTarget.key);
  }
}

export function buildAccessibleSummary(
  data: DonutChartData,
  formatCount: (value: number) => string,
): string {
  const soulItems = data.soul.exists ? 1 : 0;
  const bootstrapInstructionItems = data.bootstrapInstructions.exists ? 1 : 0;
  const threadStoredItems = data.threads.reduce((sum, thread) => sum + thread.storedCount, 0);
  const threadStoredTokens = data.threads.reduce((sum, thread) => sum + thread.storedTokens, 0);
  const totalItems = data.stateBreakdown.reduce((sum, state) => sum + state.count, 0)
    + soulItems
    + bootstrapInstructionItems
    + data.globalInbox.storedCount
    + threadStoredItems
    + data.scratch.totalEntries;
  const bootstrapItems = data.bootstrapCount + data.scratch.bootstrapEntries;
  const totalTokens = data.stateBreakdown.reduce((sum, state) => sum + state.tokens, 0)
    + data.soul.tokens
    + data.bootstrapInstructions.tokens
    + data.globalInbox.storedTokens
    + threadStoredTokens
    + data.scratch.totalTokens;

  return [
    'Memory composition donut chart.',
    `Total estimated tokens: ${formatCount(totalTokens)}.`,
    `Bootstrap estimated tokens: ${formatCount(data.bootstrapTokens + data.scratch.bootstrapTokens)}.`,
    `Total items shown: ${formatCount(totalItems)}.`,
    `Bootstrap items shown: ${formatCount(bootstrapItems)}.`,
    `Tracked threads: ${formatCount(data.threads.length)}.`,
  ].join(' ');
}

export function aggregateTypeTotals(
  breakdown: DonutChartData['stateBreakdown'],
): Map<string, { count: number; tokens: number }> {
  const totals = new Map<string, { count: number; tokens: number }>();
  for (const state of breakdown) {
    for (const type of state.types) {
      const existing = totals.get(type.label) ?? { count: 0, tokens: 0 };
      existing.count += type.count;
      existing.tokens += type.tokens;
      totals.set(type.label, existing);
    }
  }
  return totals;
}

export function overlayTargetKey(segment: InnerSegment): string {
  switch (segment.kind) {
    case 'thread':
      return `thread-bootstrap:${segment.threadId}`;
    case 'global-inbox':
      return 'global-inbox-bootstrap';
    default:
      return segment.key;
  }
}

export function overlayTooltipBody(
  formatCount: (value: number) => string,
  segment: InnerSegment,
): string {
  switch (segment.kind) {
    case 'thread':
      return threadBootstrapTooltipBody(formatCount, {
        bootstrapCount: segment.bootstrapCount,
        bootstrapTokens: segment.bootstrapTokens,
        isResolved: segment.isResolved,
        label: segment.label,
        threadInboxIncluded: segment.threadInboxIncluded,
      });
    case 'global-inbox':
      return globalInboxBootstrapTooltipBody(
        formatCount,
        segment.bootstrapTokens,
      );
    default:
      return '';
  }
}

export const BOOTSTRAP_INSTRUCTIONS_TARGET_KEY = 'bootstrap-instructions';

export function bootstrapInstructionsCenter(
  data: DonutChartData,
): { label: string; value: number } {
  return {
    label: `Bootstrap Instructions · ${data.centerLabel}`,
    value: data.unit === 'tokens'
      ? data.bootstrapInstructions.tokens
      : (data.bootstrapInstructions.exists ? 1 : 0),
  };
}

export function isCurrentBootstrapOverlay(segment: InnerSegment, resolvedThreadId: string | null): boolean {
  if (segment.kind === 'global-inbox') {
    return segment.bootstrapCount > 0;
  }
  return segment.kind === 'thread' && segment.threadId === resolvedThreadId;
}

function overlayCenterLabel(segment: InnerSegment): string {
  switch (segment.kind) {
    case 'thread':
      return segment.isResolved
        ? `Thread context add-on · ${segment.label} · current`
        : `Thread context add-on · ${segment.label}`;
    case 'global-inbox':
      return 'Global inbox bootstrap';
    default:
      return 'Bootstrap';
  }
}

function resolveInnerFocusedCenter(
  data: DonutChartData,
  segments: InnerSegment[],
  key: string,
): { label: string; value: number } {
  const segment = segments.find((entry) => entry.key === key);
  if (segment === undefined) {
    return { label: data.centerLabel, value: data.centerValue };
  }
  return {
    label: `${innerLegendLabel(segment)} · ${data.centerLabel}`,
    value: getInnerValue(segment, data.unit),
  };
}

function resolveOverlayFocusedCenter(
  data: DonutChartData,
  segments: InnerSegment[],
  key: string,
): { label: string; value: number } {
  if (key === BOOTSTRAP_INSTRUCTIONS_TARGET_KEY) {
    return bootstrapInstructionsCenter(data);
  }
  const segment = segments.find((entry) => overlayTargetKey(entry) === key);
  if (segment === undefined) {
    return { label: data.centerLabel, value: data.centerValue };
  }
  return {
    label: `${overlayCenterLabel(segment)} · ${data.centerLabel}`,
    value: data.unit === 'tokens' ? segment.bootstrapTokens : segment.bootstrapCount,
  };
}

function resolveOuterFocusedCenter(
  data: DonutChartData,
  key: string,
): { label: string; value: number } {
  const type = aggregateTypeTotals(data.stateBreakdown).get(key);
  if (type === undefined) {
    return { label: data.centerLabel, value: data.centerValue };
  }
  return {
    label: `${key} · ${data.centerLabel}`,
    value: data.unit === 'tokens' ? type.tokens : type.count,
  };
}
