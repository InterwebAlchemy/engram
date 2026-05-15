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
  swatchVariant?: 'context' | 'solid';
  target: DonutTarget;
}

export interface LegendSection {
  items: LegendItem[];
  title?: string;
}

export interface LegendColumn {
  sections: LegendSection[];
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
  opts: {
    bootstrapItems: LegendItem[];
    formatCount: (value: number) => string;
    innerItems: LegendItem[];
    outerItems: LegendItem[];
    stateBreakdown: StateSegment[];
    typeColorByLabel: Record<string, string>;
  },
): LegendColumn[] {
  const {
    bootstrapItems,
    formatCount,
    innerItems,
    outerItems,
    stateBreakdown,
    typeColorByLabel,
  } = opts;
  const typeItems = outerItems.length > 0
    ? outerItems
    : aggregateTypeTotals(stateBreakdown)
    .filter(([, totals]) => totals.count > 0)
    .map(([label, totals]) => ({
      color: typeColorByLabel[label] ?? 'var(--text-muted)',
      label,
      meta: `~${formatCount(totals.tokens)} tok`,
      target: { kind: 'outer', key: label } as const,
    }));

  return [
    {
      sections: [{ items: innerItems }],
      title: 'Memory State',
    },
    {
      sections: [
        { items: typeItems },
        ...(bootstrapItems.length > 0 ? [{ items: bootstrapItems, title: 'Bootstrap' }] : []),
      ],
      title: 'Memory Type',
    },
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
    for (const section of column.sections) {
      if (section.title !== undefined) {
        columnEl.createDiv({ cls: 'engram-donut-legend-subtitle', text: section.title });
      }
      const list = columnEl.createDiv({ cls: 'engram-donut-legend-list' });
      for (const item of section.items) {
        addLegendItem(list, item, ctx);
      }
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
  swatch.classList.toggle('is-context', item.swatchVariant === 'context');

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
  return `${state.label} · ${formatCount(state.count)} · ~${formatCount(state.tokens)} tok`;
}

export function typeTooltipBody(formatCount: (n: number) => string, stateLabel: string, type: TypeSegment): string {
  return `${stateLabel} / ${type.label} · ${formatCount(type.count)} · ~${formatCount(type.tokens)} tok`;
}

export function soulTooltipBody(formatCount: (n: number) => string, tokens: number): string {
  return `Soul · 1 doc · ~${formatCount(tokens)} tok`;
}

export function bootstrapInstructionsTooltipBody(formatCount: (n: number) => string, tokens: number): string {
  return `Bootstrap Instructions · 1 file · ~${formatCount(tokens)} tok`;
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
    bootstrapTokens,
    storedCount,
    storedTokens,
  } = details;
  const bootstrapDetail = bootstrapTokens > 0
    ? ` · ctx ~${formatCount(bootstrapTokens)} tok`
    : '';
  return `Global Inbox · ${formatCount(storedCount)} · ~${formatCount(storedTokens)} tok${bootstrapDetail}`;
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
    label,
    storedCount,
    storedTokens,
  } = details;
  return `${label} · ${formatCount(storedCount)} · ~${formatCount(storedTokens)} tok`;
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
    bootstrapTokens,
    isResolved,
    label,
  } = details;
  const scope = isResolved ? ' · current' : '';
  return `${label} Context · ~${formatCount(bootstrapTokens)} tok${scope}`;
}

export function globalInboxBootstrapTooltipBody(
  formatCount: (n: number) => string,
  bootstrapTokens: number,
): string {
  return `Global Inbox Context · ~${formatCount(bootstrapTokens)} tok`;
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
    : ` · ${activeSessions.map((session) => session.label).join(', ')}`;
  return `Scratch Context · ${formatCount(entries)} · ~${formatCount(tokens)} tok${detail}`;
}

export function scratchColdTooltipBody(
  formatCount: (n: number) => string,
  entries: number,
  tokens: number,
): string {
  return `Scratch Cold · ${formatCount(entries)} · ~${formatCount(tokens)} tok`;
}
