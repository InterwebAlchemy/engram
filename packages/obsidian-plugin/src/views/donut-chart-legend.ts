import type {
  DonutTarget,
  ScratchSession,
  StateSegment,
  TypeSegment,
} from './donut-chart-types';
import { sameDonutTarget } from './donut-chart-types';

const TOOLTIP_OFFSET = 12;

export interface LegendItem {
  color: string;
  label: string;
  meta: string;
  target: DonutTarget;
}

export interface LegendColumn {
  items: LegendItem[];
  title: string;
}

export interface LegendCtx {
  columns: LegendColumn[];
  legendOpen: boolean;
  onLegendToggle: () => void;
  onTargetEnter: (target: DonutTarget) => void;
  onTargetLeave: (target: DonutTarget) => void;
  onTargetSelect: (target: DonutTarget) => void;
  selectedTarget: DonutTarget | null;
}

export interface TooltipCtx {
  tooltip: HTMLElement;
  wrapper: HTMLElement;
}

export function buildLegendColumns(
  formatCount: (value: number) => string,
  innerItems: LegendItem[],
  stateBreakdown: StateSegment[],
  typeColorByLabel: Record<string, string>,
): LegendColumn[] {
  const outerItems = aggregateTypeTotals(stateBreakdown)
    .filter(([, totals]) => totals.count > 0)
    .map(([label, totals]) => ({
      color: typeColorByLabel[label] ?? 'var(--text-muted)',
      label,
      meta: `${formatCount(totals.count)} · ~${formatCount(totals.tokens)} tok`,
      target: { kind: 'outer', key: label } as const,
    }));

  return [
    { items: innerItems, title: 'Inner Ring' },
    { items: outerItems, title: 'Outer Ring' },
  ];
}

export function renderLegend(parent: HTMLElement, ctx: LegendCtx): void {
  const shell = parent.createDiv({
    cls: `engram-donut-legend-shell${ctx.legendOpen ? ' is-open' : ''}`,
  });
  const toggle = shell.createEl('button', {
    cls: 'engram-donut-legend-toggle',
    text: ctx.legendOpen ? 'Hide Legend' : 'Show Legend',
  });
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', String(ctx.legendOpen));
  toggle.addEventListener('click', () => {
    ctx.onLegendToggle();
  });

  const drawer = shell.createDiv({ cls: 'engram-donut-legend-drawer' });
  for (const column of ctx.columns) {
    const columnEl = drawer.createDiv({ cls: 'engram-donut-legend-column' });
    columnEl.createDiv({ cls: 'engram-donut-legend-title', text: column.title });
    const list = columnEl.createDiv({ cls: 'engram-donut-legend-list' });
    for (const item of column.items) {
      addLegendItem(list, item, ctx);
    }
  }
}

function addLegendItem(parent: HTMLElement, item: LegendItem, ctx: LegendCtx): void {
  const {
    color,
    label,
    meta,
    target,
  } = item;
  const row = parent.createEl('button', {
    cls: 'engram-donut-legend-item',
  });
  row.type = 'button';
  const { key, kind } = target;
  const { dataset } = row;
  dataset.engramFocusKind = kind;
  dataset.engramFocusKey = key;
  row.setAttribute('aria-pressed', String(sameDonutTarget(ctx.selectedTarget, target)));

  const swatch = row.createSpan({ cls: 'engram-donut-legend-swatch' });
  const { style } = swatch;
  style.background = color;

  const text = row.createDiv({ cls: 'engram-donut-legend-text' });
  text.createSpan({ cls: 'engram-donut-legend-label', text: label });
  text.createSpan({ cls: 'engram-donut-legend-meta', text: meta });

  row.addEventListener('mouseenter', () => {
    ctx.onTargetEnter(target);
  });
  row.addEventListener('mouseleave', () => {
    ctx.onTargetLeave(target);
  });
  row.addEventListener('click', () => {
    ctx.onTargetSelect(target);
  });
}

function aggregateTypeTotals(
  breakdown: StateSegment[],
): Array<[string, { count: number; tokens: number }]> {
  const totals = new Map<string, { count: number; tokens: number }>();
  for (const state of breakdown) {
    for (const type of state.types) {
      const existing = totals.get(type.label) ?? { count: 0, tokens: 0 };
      existing.count += type.count;
      existing.tokens += type.tokens;
      totals.set(type.label, existing);
    }
  }
  return Array.from(totals.entries());
}

export function bindTooltip(target: SVGElement, ctx: TooltipCtx, body: () => string): void {
  const { tooltip, wrapper } = ctx;
  target.setAttribute('aria-label', body());
  target.addEventListener('mouseenter', () => {
    tooltip.setText(body());
    tooltip.style.opacity = '1';
  });
  target.addEventListener('mousemove', (event) => {
    const rect = wrapper.getBoundingClientRect();
    const x = event.clientX - rect.left + TOOLTIP_OFFSET;
    const y = event.clientY - rect.top + TOOLTIP_OFFSET;
    tooltip.style.left = `${String(x)}px`;
    tooltip.style.top = `${String(y)}px`;
  });
  target.addEventListener('mouseleave', () => {
    tooltip.style.opacity = '0';
  });
}

export function stateTooltipBody(formatCount: (n: number) => string, state: StateSegment): string {
  return `${state.label} · ${formatCount(state.count)} memories · ~${formatCount(state.tokens)} tokens`;
}

export function typeTooltipBody(formatCount: (n: number) => string, stateLabel: string, type: TypeSegment): string {
  return `${stateLabel} · ${type.label} · ${formatCount(type.count)} · ~${formatCount(type.tokens)} tokens`;
}

export function soulTooltipBody(formatCount: (n: number) => string, tokens: number): string {
  return `Soul · identity anchor · 1 doc · ~${formatCount(tokens)} tokens · loaded at bootstrap`;
}

export function globalInboxTooltipBody(
  formatCount: (n: number) => string,
  details: {
    bootstrapCount: number;
    bootstrapTokens: number;
    storedCount: number;
    storedTokens: number;
  },
): string {
  const {
    bootstrapCount,
    bootstrapTokens,
    storedCount,
    storedTokens,
  } = details;
  const bootstrapDetail = bootstrapCount > 0
    ? ` · bootstrap ${formatCount(bootstrapCount)} section · ~${formatCount(bootstrapTokens)} tokens`
    : '';
  return `Global inbox · ${formatCount(storedCount)} stored notes · ~${formatCount(storedTokens)} tokens${bootstrapDetail}`;
}

export function threadTooltipBody(
  formatCount: (n: number) => string,
  details: {
    bootstrapCount: number;
    bootstrapTokens: number;
    label: string;
    storedCount: number;
    storedTokens: number;
    threadInboxIncluded: boolean;
  },
): string {
  const {
    bootstrapCount,
    bootstrapTokens,
    label,
    storedCount,
    storedTokens,
    threadInboxIncluded,
  } = details;
  const includedParts = [
    bootstrapCount > 0 ? 'thread summary' : null,
    threadInboxIncluded ? 'thread inbox' : null,
  ].filter((detail): detail is string => detail !== null);
  const bootstrapDetail = bootstrapCount > 0
    ? ` · bootstrap ${formatCount(bootstrapCount)} sections · ~${formatCount(bootstrapTokens)} tokens`
    : '';
  const suffix = includedParts.length > 0 ? ` · includes ${includedParts.join(', ')}` : '';
  return `Thread · ${label} · ${formatCount(storedCount)} stored items · ~${formatCount(storedTokens)} tokens${bootstrapDetail}${suffix}`;
}

export function threadBootstrapTooltipBody(
  formatCount: (n: number) => string,
  details: {
    bootstrapCount: number;
    bootstrapTokens: number;
    isResolved: boolean;
    label: string;
    threadInboxIncluded: boolean;
  },
): string {
  const {
    bootstrapCount,
    bootstrapTokens,
    isResolved,
    label,
    threadInboxIncluded,
  } = details;
  const parts = [
    'thread summary',
    threadInboxIncluded ? 'thread inbox' : null,
  ].filter((part): part is string => part !== null);
  const scope = isResolved ? 'current bootstrap' : 'if initialized from this thread';
  return `Thread bootstrap · ${label} · ${scope} · ${formatCount(bootstrapCount)} sections · ~${formatCount(bootstrapTokens)} tokens${parts.length > 0 ? ` · ${parts.join(', ')}` : ''}`;
}

export function globalInboxBootstrapTooltipBody(
  formatCount: (n: number) => string,
  bootstrapCount: number,
  bootstrapTokens: number,
): string {
  return `Global inbox bootstrap · ${formatCount(bootstrapCount)} section · ~${formatCount(bootstrapTokens)} tokens`;
}

export function scratchBootstrapTooltipBody(
  formatCount: (n: number) => string,
  entries: number,
  tokens: number,
  sessions: ScratchSession[],
): string {
  const activeSessions = sessions.filter((session) => session.bootstrapEntryCount > 0);
  const detail = activeSessions.length === 0
    ? ''
    : ` · ${activeSessions.map((session) => `${session.label} ${formatCount(session.bootstrapEntryCount)}`).join(', ')}`;
  return `Scratch · in bootstrap · ${formatCount(entries)} entries · ~${formatCount(tokens)} rendered tokens${detail}`;
}

export function scratchColdTooltipBody(
  formatCount: (n: number) => string,
  entries: number,
  tokens: number,
): string {
  return `Scratch · cold (vault only) · ${formatCount(entries)} entries · ~${formatCount(tokens)} stored tokens`;
}
