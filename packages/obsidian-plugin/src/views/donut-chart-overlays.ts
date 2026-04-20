import { appendContextCap } from './donut-chart-svg';
import {
  bindTooltip,
} from './donut-chart-legend';
import {
  decorateInteractiveElement,
} from './donut-chart-focus';
import {
  getInnerValue,
  type InnerSegment,
} from './donut-chart-inner';
import {
  isCurrentBootstrapOverlay,
  overlayTargetKey,
  overlayTooltipBody,
} from './donut-chart-metrics';
import type { DonutChartData, InteractionState } from './donut-chart-types';

export function renderContextCapOverlay(opts: {
  data: DonutChartData;
  frame: HTMLElement;
  formatCount: (value: number) => string;
  interaction: InteractionState;
  placement: { endDeg: number; segment: InnerSegment; startDeg: number };
  svg: SVGElement;
  tooltip: HTMLElement;
  wrapper: HTMLElement;
}): void {
  const {
    data,
    formatCount,
    frame,
    interaction,
    placement,
    svg,
    tooltip,
    wrapper,
  } = opts;
  const { endDeg, segment, startDeg } = placement;
  if (!isContextCapSegment(segment)) {
    return;
  }

  const totalValue = getInnerValue(segment, data.unit);
  const bootstrapValue = getBootstrapValue(segment, data.unit);
  if (totalValue <= 0 || bootstrapValue <= 0) {
    return;
  }

  const ratio = Math.min(bootstrapValue / totalValue, 1);
  const capEndDeg = startDeg + ((endDeg - startDeg) * ratio);
  const cap = appendContextCap(svg, startDeg, capEndDeg);
  applyContextCapAppearance(cap, segment);

  bindTooltip(cap, { tooltip, wrapper }, () => overlayTooltipBody(formatCount, segment));
  decorateInteractiveElement(
    cap,
    { frame, interaction },
    { kind: 'overlay', key: overlayTargetKey(segment) },
    {
      bootstrap: isCurrentBootstrapOverlay(segment, data.resolvedThreadId),
      innerKey: segment.key,
      relatedKey: segment.key,
    },
  );
}

function isContextCapSegment(segment: InnerSegment): segment is Extract<InnerSegment, { kind: 'global-inbox' | 'thread' }> {
  return segment.kind === 'thread' || segment.kind === 'global-inbox';
}

function getBootstrapValue(
  segment: Extract<InnerSegment, { kind: 'global-inbox' | 'thread' }>,
  unit: DonutChartData['unit'],
): number {
  return unit === 'tokens' ? segment.bootstrapTokens : segment.bootstrapCount;
}

function applyContextCapAppearance(
  cap: SVGPathElement,
  segment: Extract<InnerSegment, { kind: 'global-inbox' | 'thread' }>,
): void {
  cap.style.setProperty(
    '--engram-context-cap-color',
    segment.kind === 'thread'
      ? 'color-mix(in srgb, white 92%, var(--text-normal) 8%)'
      : segment.color,
  );
  cap.classList.add(segment.kind === 'thread' ? 'is-thread-cap' : 'is-global-inbox-cap');
  if (segment.kind === 'thread' && segment.isResolved) {
    cap.classList.add('is-current-thread');
  }
}
