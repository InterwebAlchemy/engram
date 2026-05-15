import {
  BOOTSTRAP_INSTRUCTIONS_TARGET_KEY,
  overlayTargetKey,
} from './donut-chart-metrics';
import {
  buildInnerSegments,
  getInnerValue,
} from './donut-chart-inner';
import type { LegendItem } from './donut-chart-legend';
import type { DonutChartData } from './donut-chart-types';

export function buildBootstrapLegendItems(
  data: DonutChartData,
  formatCount: (value: number) => string,
): LegendItem[] {
  const items: LegendItem[] = [];
  const sharedBootstrapValue = data.unit === 'tokens'
    ? data.bootstrapTokens + data.scratch.bootstrapTokens
    : data.bootstrapCount + data.scratch.bootstrapEntries;
  if (sharedBootstrapValue > 0) {
    items.push({
      color: 'color-mix(in srgb, var(--text-accent) 14%, transparent)',
      label: 'Shared Bootstrap',
      meta: `~${formatCount(sharedBootstrapValue)} ${data.unit === 'tokens' ? 'tok' : 'items'}`,
      swatchVariant: 'context',
      target: { kind: 'bootstrap', key: 'bootstrap' } as const,
    });
  }
  if (data.bootstrapInstructions.exists) {
    items.push({
      color: data.bootstrapInstructions.color,
      label: 'Bootstrap Instructions',
      meta: `~${formatCount(data.bootstrapInstructions.tokens)} tok`,
      swatchVariant: 'solid',
      target: { kind: 'overlay', key: BOOTSTRAP_INSTRUCTIONS_TARGET_KEY } as const,
    });
  }

  for (const segment of buildInnerSegments(data)) {
    if (segment.kind === 'thread' && segment.bootstrapTokens > 0) {
      items.push({
        color: 'color-mix(in srgb, var(--text-accent) 14%, transparent)',
        label: 'Thread Context',
        meta: `${segment.label} · +~${formatCount(segment.bootstrapTokens)} tok`,
        swatchVariant: 'context',
        target: { kind: 'overlay', key: overlayTargetKey(segment) } as const,
      });
      continue;
    }
    if (segment.kind === 'global-inbox' && segment.bootstrapTokens > 0) {
      items.push({
        color: segment.color,
        label: 'Global Inbox Context',
        meta: `+~${formatCount(segment.bootstrapTokens)} tok`,
        swatchVariant: 'context',
        target: { kind: 'overlay', key: overlayTargetKey(segment) } as const,
      });
    }
  }

  return items;
}

export function buildTypeLegendItems(
  data: DonutChartData,
  formatCount: (value: number) => string,
): LegendItem[] {
  const totals = new Map<string, { count: number; tokens: number }>();
  for (const state of data.stateBreakdown) {
    for (const type of state.types) {
      const existing = totals.get(type.label) ?? { count: 0, tokens: 0 };
      existing.count += type.count;
      existing.tokens += type.tokens;
      totals.set(type.label, existing);
    }
  }

  return Array.from(totals.entries()).map(([label, total]) => ({
    color: data.typeColorByLabel[label] ?? 'var(--text-muted)',
    label,
    meta: `~${formatCount(total.tokens)} tok`,
    target: { kind: 'outer', key: label } as const,
  }));
}

export function buildStateLegendItems(
  data: DonutChartData,
  formatCount: (value: number) => string,
): LegendItem[] {
  const items: LegendItem[] = [];
  for (const segment of buildInnerSegments(data)) {
    if (segment.kind === 'thread') {
      items.push({
        color: segment.color,
        label: segment.label,
        meta: `${segment.isResolved ? 'current · ' : ''}~${formatCount(segment.tokens)} tok`,
        target: { kind: 'inner', key: segment.key } as const,
      });
      continue;
    }

    items.push({
      color: segment.color,
      label: segment.label,
      meta: `~${formatCount(getInnerValue(segment, 'tokens'))} tok`,
      target: { kind: 'inner', key: segment.key } as const,
    });
  }
  return items;
}
