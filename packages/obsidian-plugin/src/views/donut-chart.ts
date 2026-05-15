import {
  ARC_GAP_DEG,
  ARC_START_DEG,
  FULL_CIRCLE,
  INNER_R_IN,
  INNER_R_OUT,
  OUTER_R_IN,
  OUTER_R_OUT,
  SECTION_GAP_DEG,
  appendArc,
  appendReclaimArc,
  appendTrackRing,
  createSvg,
} from './donut-chart-svg';
import {
  bindTooltip,
  buildLegendColumns,
  globalInboxTooltipBody,
  renderLegend,
  scratchBootstrapTooltipBody,
  scratchColdTooltipBody,
  soulTooltipBody,
  stateTooltipBody,
  threadTooltipBody,
  typeTooltipBody,
} from './donut-chart-legend';
import {
  buildBootstrapLegendItems,
  buildStateLegendItems,
  buildTypeLegendItems,
} from './donut-chart-legend-builders';
import {
  applyInteractionState,
  decorateInteractiveElement,
} from './donut-chart-focus';
import {
  buildInnerSegments,
  getInnerValue,
  type InnerSegment,
} from './donut-chart-inner';
import {
  buildAccessibleSummary,
  overlayTargetKey,
  resolveFocusedCenter,
} from './donut-chart-metrics';
import { renderBootstrapInstructionsArc } from './donut-chart-bootstrap-instructions';
import { renderBootstrapWedge } from './donut-chart-bootstrap-wedge';
import { renderContextCapOverlay } from './donut-chart-overlays';
import type {
  DonutChartData,
  TypeSegment,
} from './donut-chart-types';
import { InteractionState } from './donut-chart-types';

export type {
  BootstrapInstructionsInfo,
  DonutChartData,
  GlobalInboxInfo,
  ScratchInfo,
  ScratchSession,
  SoulInfo,
  StateSegment,
  ThreadInfo,
  TypeSegment,
} from './donut-chart-types';

interface AngularPlacement {
  endDeg: number;
  startDeg: number;
}

interface RenderContext {
  data: DonutChartData;
  formatCount: (value: number) => string;
  frame: HTMLElement;
  interaction: InteractionState;
  onInteractionChange?: () => void;
  ring: HTMLElement;
  tooltip: HTMLElement;
  wrapper: HTMLElement;
}

interface InnerLayout {
  grandTotal: number;
  spans: Array<{ endDeg: number; segment: InnerSegment; startDeg: number }>;
  bootstrapWedge: AngularPlacement | null;
}

const MIN_THREAD_SPAN_DEG = 3.5;
const THOUSAND = 1_000;
const TEN = 10;
const HUNDRED = 100;
const ONE_DECIMAL_DIGITS = 1;
const TWO_DECIMAL_DIGITS = 2;

export function renderDonutChart(
  parent: HTMLElement,
  data: DonutChartData,
  formatCount: (value: number) => string,
): void {
  const frame = parent.createDiv({ cls: 'engram-donut-frame' });
  const wrapper = frame.createDiv({ cls: 'engram-donut-wrapper' });
  const ring = wrapper.createDiv({ cls: 'engram-donut-ring' });
  const tooltip = frame.createDiv({ cls: 'engram-donut-tooltip' });
  tooltip.style.opacity = '0';

  const ctx: RenderContext = {
    data,
    formatCount,
    frame,
    interaction: new InteractionState(),
    onInteractionChange: () => {
      updateCenterDisplay(ctx);
    },
    ring,
    tooltip,
    wrapper: frame,
  };

  renderRing(ctx);

  let legendOpen = false;
  const renderLegendShell = (): void => {
    ctx.frame.querySelector('.engram-donut-legend-shell')?.remove();
    renderLegendForCtx(ctx, legendOpen, () => {
      legendOpen = !legendOpen;
      renderLegendShell();
    });
  };

  renderLegendShell();
  updateCenterDisplay(ctx);
  updateAccessibleSummary(ctx);
}

function renderRing(ctx: RenderContext): void {
  ctx.ring.empty();
  const svg = createSvg();
  const layout = computeLayout(ctx.data);

  appendTrackRing(svg, OUTER_R_OUT, OUTER_R_IN);
  appendTrackRing(svg, INNER_R_OUT, INNER_R_IN);

  if (layout.grandTotal > 0) {
    renderOuterRing(svg, ctx, layout);
    renderInnerRing(svg, ctx, layout);
    renderBootstrapWedge({
      data: ctx.data,
      formatCount: ctx.formatCount,
      frame: ctx.frame,
      interaction: ctx.interaction,
      onInteractionChange: ctx.onInteractionChange,
      placement: layout.bootstrapWedge,
      svg,
    });
    renderBootstrapInstructionsArc({
      data: ctx.data,
      formatCount: ctx.formatCount,
      frame: ctx.frame,
      interaction: ctx.interaction,
      onInteractionChange: ctx.onInteractionChange,
      placement: layout.bootstrapWedge,
      svg,
      tooltip: ctx.tooltip,
      wrapper: ctx.wrapper,
    });
    renderReclaimOverlay(svg, ctx, layout);
  }

  ctx.ring.appendChild(svg);

  const center = ctx.ring.createDiv({ cls: 'engram-donut-center' });
  center.createDiv({ cls: 'engram-donut-center-value' });
  center.createDiv({ cls: 'engram-donut-center-label' });
  updateCenterDisplay(ctx);
  updateAccessibleSummary(ctx);
}

function computeLayout(data: DonutChartData): InnerLayout {
  const segments = buildInnerSegments(data);
  if (segments.length === 0) {
    return { grandTotal: 0, spans: [], bootstrapWedge: null };
  }

  const values = segments.map((segment) => getInnerValue(segment, data.unit));
  const grandTotal = values.reduce((sum, value) => sum + value, 0);
  if (grandTotal <= 0) {
    return { grandTotal: 0, spans: [], bootstrapWedge: null };
  }

  const available = FULL_CIRCLE - SECTION_GAP_DEG * segments.length;
  const spansByIndex = computeSegmentSpans(segments, values, grandTotal, available);

  let cursor = ARC_START_DEG;
  const spans = segments.map((segment, index) => {
    const span = spansByIndex[index] ?? 0;
    const placement = { segment, startDeg: cursor, endDeg: cursor + span };
    cursor += span + SECTION_GAP_DEG;
    return placement;
  });

  const bootstrapSpans = spans.filter(({ segment }) => segment.bootstrap);
  const bootstrapWedge = bootstrapSpans.length === 0
    ? null
    : {
      startDeg: bootstrapSpans[0].startDeg,
      endDeg: bootstrapSpans[bootstrapSpans.length - 1].endDeg,
    };

  return { grandTotal, spans, bootstrapWedge };
}

function computeSegmentSpans(
  segments: InnerSegment[],
  values: number[],
  grandTotal: number,
  available: number,
): number[] {
  const minimums: number[] = segments.map((segment) => (segment.kind === 'thread' ? MIN_THREAD_SPAN_DEG : 0));
  const minimumTotal = minimums.reduce((sum, value) => sum + value, 0);

  if (minimumTotal >= available) {
    return minimums.map((value) => (value / minimumTotal) * available);
  }

  const proportionalAvailable = available - minimumTotal;
  return segments.map((_, index) => {
    const proportionalSpan = grandTotal > 0 ? (values[index] / grandTotal) * proportionalAvailable : 0;
    return minimums[index] + proportionalSpan;
  });
}

function getTypeValue(type: TypeSegment, unit: DonutChartData['unit']): number {
  return unit === 'tokens' ? type.tokens : type.count;
}

function renderInnerRing(svg: SVGElement, ctx: RenderContext, layout: InnerLayout): void {
  for (const placement of layout.spans) {
    if (placement.segment.kind !== 'state') {
      continue;
    }
    const innerArc = appendArc({
      svg,
      rOut: INNER_R_OUT,
      rIn: INNER_R_IN,
      startDeg: placement.startDeg,
      endDeg: placement.endDeg,
      color: placement.segment.color,
    });
    bindTooltip(innerArc, ctx, () => innerTooltipBody(ctx, placement.segment));
    decorateInteractiveElement(innerArc, ctx, { kind: 'inner', key: placement.segment.key }, {
      bootstrap: placement.segment.bootstrap,
    });
  }
}

function renderOuterRing(svg: SVGElement, ctx: RenderContext, layout: InnerLayout): void {
  for (const placement of layout.spans) {
    if (placement.segment.kind === 'state') {
      renderTypeSubdivisions(svg, ctx, placement);
      continue;
    }
    renderFullWidthSlice(svg, ctx, placement);
  }
}

function renderTypeSubdivisions(
  svg: SVGElement,
  ctx: RenderContext,
  placement: { endDeg: number; segment: InnerSegment; startDeg: number },
): void {
  if (placement.segment.kind !== 'state') {
    return;
  }
  const visibleTypes = placement.segment.types.filter((type) => getTypeValue(type, ctx.data.unit) > 0);
  if (visibleTypes.length <= 0) {
    return;
  }

  const typeGapCount = visibleTypes.length > 1 ? visibleTypes.length - 1 : 0;
  const stateSpan = placement.endDeg - placement.startDeg;
  const available = stateSpan - ARC_GAP_DEG * typeGapCount;
  const total = visibleTypes.reduce((sum, type) => sum + getTypeValue(type, ctx.data.unit), 0);

  let { startDeg: cursor } = placement;
  for (const type of visibleTypes) {
    const span = (getTypeValue(type, ctx.data.unit) / total) * available;
    const color = ctx.data.typeColorByLabel[type.label] ?? type.color;
    const arc = appendArc({
      svg,
      rOut: OUTER_R_OUT,
      rIn: OUTER_R_IN,
      startDeg: cursor,
      endDeg: cursor + span,
      color,
    });
    bindTooltip(arc, ctx, () => typeTooltipBody(ctx.formatCount, placement.segment.label, type));
    decorateInteractiveElement(
      arc,
      ctx,
      { kind: 'outer', key: type.label },
      {
        bootstrap: placement.segment.bootstrap,
        innerKey: placement.segment.key,
      },
    );
    cursor += span + ARC_GAP_DEG;
  }
}

function renderFullWidthSlice(
  svg: SVGElement,
  ctx: RenderContext,
  placement: { endDeg: number; segment: InnerSegment; startDeg: number },
): void {
  if (placement.segment.kind === 'state') {
    return;
  }
  const arc = appendArc({
    svg,
    rOut: OUTER_R_OUT,
    rIn: INNER_R_IN,
    startDeg: placement.startDeg,
    endDeg: placement.endDeg,
    color: placement.segment.color,
  });
  arc.classList.add('engram-donut-full-span-slice');
  if (placement.segment.kind === 'soul') {
    arc.classList.add('engram-donut-soul-slice');
  }
  if (placement.segment.kind === 'global-inbox') {
    arc.classList.add('engram-donut-global-inbox-slice');
  }
  if (placement.segment.kind === 'thread') {
    arc.classList.add('engram-donut-thread-slice');
    if (placement.segment.isResolved) {
      arc.classList.add('is-current-thread');
    }
  }
  if (placement.segment.kind === 'scratch-bootstrap') {
    arc.classList.add('engram-donut-scratch-bootstrap');
  }
  if (placement.segment.kind === 'scratch-cold') {
    arc.classList.add('engram-donut-scratch-cold');
  }
  bindTooltip(arc, ctx, () => innerTooltipBody(ctx, placement.segment));
  decorateInteractiveElement(
    arc,
    ctx,
    { kind: 'inner', key: placement.segment.key },
    {
      bootstrap: placement.segment.bootstrap,
      relatedKey: overlayTargetKey(placement.segment),
    },
  );
  renderContextCapOverlay({
    data: ctx.data,
    formatCount: ctx.formatCount,
    frame: ctx.frame,
    interaction: ctx.interaction,
    placement,
    svg,
    tooltip: ctx.tooltip,
    wrapper: ctx.wrapper,
  });
}

function innerTooltipBody(ctx: RenderContext, segment: InnerSegment): string {
  switch (segment.kind) {
    case 'state':
      return stateTooltipBody(ctx.formatCount, segment);
    case 'soul':
      return soulTooltipBody(ctx.formatCount, segment.tokens);
    case 'global-inbox':
      return globalInboxTooltipBody(ctx.formatCount, {
        bootstrapCount: segment.bootstrapCount,
        bootstrapTokens: segment.bootstrapTokens,
        storedCount: segment.count,
        storedTokens: segment.tokens,
      });
    case 'thread':
      return threadTooltipBody(ctx.formatCount, {
        bootstrapCount: segment.bootstrapCount,
        bootstrapTokens: segment.bootstrapTokens,
        label: segment.label,
        storedCount: segment.count,
        storedTokens: segment.tokens,
        threadInboxIncluded: segment.threadInboxIncluded,
      });
    case 'scratch-bootstrap':
      return scratchBootstrapTooltipBody(
        ctx.formatCount,
        segment.count,
        segment.tokens,
        segment.sessions,
      );
    case 'scratch-cold':
      return scratchColdTooltipBody(ctx.formatCount, segment.count, segment.tokens);
  }
}

function renderReclaimOverlay(svg: SVGElement, ctx: RenderContext, layout: InnerLayout): void {
  if (ctx.data.napReclaimCount <= 0) {
    return;
  }
  const forgotten = layout.spans.find(({ segment }) => segment.kind === 'state' && segment.label === 'Forgotten');
  if (forgotten === undefined || forgotten.segment.count <= 0) {
    return;
  }

  const forgottenSpan = forgotten.endDeg - forgotten.startDeg;
  const reclaimRatio = Math.min(ctx.data.napReclaimCount / forgotten.segment.count, 1);
  appendReclaimArc(svg, forgotten.endDeg - forgottenSpan * reclaimRatio, forgotten.endDeg);
}

function renderLegendForCtx(ctx: RenderContext, legendOpen: boolean, onLegendToggle: () => void): void {
  const columns = buildLegendColumns({
    bootstrapItems: buildBootstrapLegendItems(ctx.data, ctx.formatCount),
    formatCount: ctx.formatCount,
    innerItems: buildStateLegendItems(ctx.data, ctx.formatCount),
    outerItems: buildTypeLegendItems(ctx.data, ctx.formatCount),
    stateBreakdown: ctx.data.stateBreakdown,
    typeColorByLabel: ctx.data.typeColorByLabel,
  });
  renderLegend(ctx.frame, {
    columns,
    legendOpen,
    onLegendToggle,
    onTargetEnter: (target) => {
      ctx.interaction.setHover(target);
      applyInteractionState(ctx);
    },
    onTargetLeave: (target) => {
      ctx.interaction.clearHover(target);
      applyInteractionState(ctx);
    },
    onTargetSelect: (target) => {
      ctx.interaction.toggleSelected(target);
      applyInteractionState(ctx);
    },
    selectedTarget: ctx.interaction.selected,
  });
}

function updateCenterDisplay(ctx: RenderContext): void {
  const centerValueEl = ctx.ring.querySelector<HTMLElement>('.engram-donut-center-value');
  const centerLabelEl = ctx.ring.querySelector<HTMLElement>('.engram-donut-center-label');
  if (centerValueEl === null || centerLabelEl === null) {
    return;
  }
  const focus = resolveFocusedCenter(ctx.data, ctx.interaction.activeTarget);
  centerValueEl.setText(`~${formatCompactCount(focus.value)}`);
  centerLabelEl.setText(ctx.data.unit === 'tokens' ? 'tokens' : 'items');
}

function updateAccessibleSummary(ctx: RenderContext): void {
  ctx.ring.setAttribute('role', 'group');
  ctx.ring.setAttribute('aria-label', buildAccessibleSummary(ctx.data, ctx.formatCount));
}

function formatCompactCount(value: number): string {
  const absolute = Math.abs(value);
  if (absolute < THOUSAND) {
    return Math.round(value).toLocaleString();
  }

  const units = [
    { suffix: 'T', value: 1_000_000_000_000 },
    { suffix: 'B', value: 1_000_000_000 },
    { suffix: 'M', value: 1_000_000 },
    { suffix: 'K', value: 1_000 },
  ] as const;

  for (const unit of units) {
    if (absolute < unit.value) {
      continue;
    }
    const scaled = value / unit.value;
    const digits = Math.abs(scaled) >= HUNDRED ? 0 : (Math.abs(scaled) >= TEN ? ONE_DECIMAL_DIGITS : TWO_DECIMAL_DIGITS);
    return `${stripTrailingZeroes(scaled.toFixed(digits))}${unit.suffix}`;
  }

  return Math.round(value).toLocaleString();
}

function stripTrailingZeroes(value: string): string {
  return value.replace(/\.0+$|(?<decimal>\.\d*[1-9])0+$/u, '$<decimal>');
}
