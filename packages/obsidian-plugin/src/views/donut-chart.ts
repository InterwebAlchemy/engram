/**
 * SVG-based nested donut chart for the Memory overview.
 * Inner ring shows memory state, outer ring shows type breakdown per state.
 * Overlay arcs highlight bootstrap context load and reclaimable regions.
 */

/* ─── Constants ──────────────────────────────────────────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';
const DONUT_SIZE = 260;
const DONUT_HALF = 130;
const DONUT_CX = DONUT_HALF;
const DONUT_CY = DONUT_HALF;
const OUTER_R_OUT = 124;
const OUTER_R_IN = 100;
const INNER_R_OUT = 94;
const INNER_R_IN = 72;
const ARC_GAP_DEG = 1.5;
const ARC_START_DEG = -90;
const HALF_CIRCLE = 180;
const DEG_TO_RAD = Math.PI / HALF_CIRCLE;
const FULL_CIRCLE = 360;
const TRACK_CLOSE_OFFSET = 0.01;
const BOOTSTRAP_PAD = 3;
const RECLAIM_PAD = 2;
const BOOTSTRAP_LABEL_OFFSET = 28;
const MIDPOINT_DIVISOR = 2;

/* ─── Interfaces ─────────────────────────────────────────────────────────── */

interface TypeSegment {
  color: string;
  count: number;
  label: string;
}

interface StateSegment {
  color: string;
  count: number;
  label: string;
  types: TypeSegment[];
}

export interface DonutChartData {
  bootstrapCount: number;
  bootstrapTokens: number;
  centerLabel: string;
  centerValue: number;
  dreamTargetCount: number;
  napReclaimCount: number;
  stateBreakdown: StateSegment[];
  typeColorByLabel: Record<string, string>;
}

/* ─── Public API ─────────────────────────────────────────────────────────── */

export function renderDonutChart(
  parent: HTMLElement,
  data: DonutChartData,
  formatCount: (value: number) => string,
): void {
  const wrapper = parent.createDiv({ cls: 'engram-donut-wrapper' });
  const ring = wrapper.createDiv({ cls: 'engram-donut-ring' });
  const svg = createSvg();

  appendTrackRing(svg, OUTER_R_OUT, OUTER_R_IN);
  appendTrackRing(svg, INNER_R_OUT, INNER_R_IN);

  const total = data.stateBreakdown.reduce((sum, s) => sum + s.count, 0);
  if (total > 0) {
    const endAngle = renderSegments(svg, data, total);
    renderOverlays(svg, data, total, endAngle);
  }

  ring.appendChild(svg);

  const center = ring.createDiv({ cls: 'engram-donut-center' });
  center.createDiv({ cls: 'engram-donut-center-value', text: formatCount(data.centerValue) });
  center.createDiv({ cls: 'engram-donut-center-label', text: data.centerLabel });

  renderAnnotations(wrapper, data, formatCount);
}

/* ─── Segment rendering ──────────────────────────────────────────────────── */

interface TypeSubdivisionOpts {
  stateStart: number;
  stateSpan: number;
  svg: SVGElement;
  typeColorByLabel: Record<string, string>;
  types: TypeSegment[];
  typeTotal: number;
}

function renderSegments(
  svg: SVGElement,
  data: DonutChartData,
  total: number,
): number {
  const { stateBreakdown, typeColorByLabel } = data;
  const { length: nonZero } = stateBreakdown.filter((s) => s.count > 0);
  const available = FULL_CIRCLE - ARC_GAP_DEG * nonZero;
  let angle = ARC_START_DEG;

  for (const state of stateBreakdown) {
    if (state.count <= 0) {
      continue;
    }
    const stateSpan = (state.count / total) * available;

    appendArc({ svg, rOut: INNER_R_OUT, rIn: INNER_R_IN, startDeg: angle, endDeg: angle + stateSpan, color: state.color });
    renderTypeSubdivisions({ svg, types: state.types, typeColorByLabel, stateStart: angle, stateSpan, typeTotal: state.count });

    angle += stateSpan + ARC_GAP_DEG;
  }

  return angle;
}

function renderTypeSubdivisions(opts: TypeSubdivisionOpts): void {
  const { svg, types, typeColorByLabel, stateStart, stateSpan, typeTotal } = opts;
  const { length: nonZeroTypes } = types.filter((t) => t.count > 0);
  if (nonZeroTypes <= 0) {
    return;
  }
  const typeGapCount = nonZeroTypes > 1 ? nonZeroTypes - 1 : 0;
  const typeAvailable = stateSpan - ARC_GAP_DEG * typeGapCount;
  let typeAngle = stateStart;
  for (const type of types) {
    if (type.count <= 0) {
      continue;
    }
    const typeSpan = (type.count / typeTotal) * typeAvailable;
    const color = typeColorByLabel[type.label] ?? type.color;
    appendArc({ svg, rOut: OUTER_R_OUT, rIn: OUTER_R_IN, startDeg: typeAngle, endDeg: typeAngle + typeSpan, color });
    typeAngle += typeSpan + ARC_GAP_DEG;
  }
}

/* ─── Overlay rendering ──────────────────────────────────────────────────── */

function renderOverlays(
  svg: SVGElement,
  data: DonutChartData,
  total: number,
  finalAngle: number,
): void {
  if (data.bootstrapCount > 0) {
    const bootstrapEnd = computeBootstrapEnd(data, total);
    appendBootstrapArc(svg, ARC_START_DEG, bootstrapEnd);
  }

  if (data.napReclaimCount > 0) {
    renderReclaimOverlay(svg, data, total, finalAngle);
  }
}

function computeBootstrapEnd(data: DonutChartData, total: number): number {
  const { stateBreakdown } = data;
  const { length: nonZero } = stateBreakdown.filter((s) => s.count > 0);
  const available = FULL_CIRCLE - ARC_GAP_DEG * nonZero;
  let angle = ARC_START_DEG;
  let bootstrapEnd = ARC_START_DEG;
  for (const state of stateBreakdown) {
    if (state.count <= 0) {
      continue;
    }
    const stateSpan = (state.count / total) * available;
    if (state.label === 'Core' || state.label === 'Remembered') {
      bootstrapEnd = angle + stateSpan;
    }
    angle += stateSpan + ARC_GAP_DEG;
  }
  return bootstrapEnd;
}

function renderReclaimOverlay(
  svg: SVGElement,
  data: DonutChartData,
  total: number,
  finalAngle: number,
): void {
  const { stateBreakdown, napReclaimCount } = data;
  const forgottenState = stateBreakdown.find((s) => s.label === 'Forgotten');
  if (forgottenState === undefined || forgottenState.count <= 0) {
    return;
  }
  const { length: nonZero } = stateBreakdown.filter((s) => s.count > 0);
  const available = FULL_CIRCLE - ARC_GAP_DEG * nonZero;
  const forgottenEnd = finalAngle - ARC_GAP_DEG;
  const forgottenSpan = (forgottenState.count / total) * available;
  const reclaimRatio = Math.min(napReclaimCount / forgottenState.count, 1);
  const reclaimSpan = forgottenSpan * reclaimRatio;
  appendReclaimArc(svg, forgottenEnd - reclaimSpan, forgottenEnd);
}

/* ─── Annotations ────────────────────────────────────────────────────────── */

function renderAnnotations(
  parent: HTMLElement,
  data: DonutChartData,
  formatCount: (value: number) => string,
): void {
  const annotations = parent.createDiv({ cls: 'engram-donut-annotations' });

  const bootstrapChip = annotations.createDiv({ cls: 'engram-donut-chip is-bootstrap' });
  bootstrapChip.createDiv({ cls: 'engram-donut-chip-value', text: formatCount(data.bootstrapCount) });
  bootstrapChip.createDiv({ cls: 'engram-donut-chip-label', text: 'load at bootstrap' });
  bootstrapChip.createDiv({
    cls: 'engram-donut-chip-detail',
    text: `~${formatCount(data.bootstrapTokens)} tokens`,
  });

  if (data.napReclaimCount > 0) {
    const napChip = annotations.createDiv({ cls: 'engram-donut-chip is-nap' });
    napChip.createDiv({ cls: 'engram-donut-chip-value', text: formatCount(data.napReclaimCount) });
    napChip.createDiv({ cls: 'engram-donut-chip-label', text: 'Power Nap can reclaim' });
  }

  if (data.dreamTargetCount > 0) {
    const dreamChip = annotations.createDiv({ cls: 'engram-donut-chip is-dream' });
    dreamChip.createDiv({ cls: 'engram-donut-chip-value', text: formatCount(data.dreamTargetCount) });
    dreamChip.createDiv({ cls: 'engram-donut-chip-label', text: 'need Dream review' });
  }
}

/* ─── SVG primitives ─────────────────────────────────────────────────────── */

function createSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(DONUT_SIZE)} ${String(DONUT_SIZE)}`);
  svg.classList.add('engram-donut-svg');
  return svg;
}

function polarToXY(r: number, angleDeg: number): { x: number; y: number } {
  const rad = angleDeg * DEG_TO_RAD;
  return { x: DONUT_CX + r * Math.cos(rad), y: DONUT_CY + r * Math.sin(rad) };
}

function describeArc(
  rOut: number,
  rIn: number,
  startDeg: number,
  endDeg: number,
): string {
  const large = Math.abs(endDeg - startDeg) > HALF_CIRCLE ? 1 : 0;
  const os = polarToXY(rOut, startDeg);
  const oe = polarToXY(rOut, endDeg);
  const ie = polarToXY(rIn, endDeg);
  const is_ = polarToXY(rIn, startDeg);
  return [
    `M ${String(os.x)} ${String(os.y)}`,
    `A ${String(rOut)} ${String(rOut)} 0 ${String(large)} 1 ${String(oe.x)} ${String(oe.y)}`,
    `L ${String(ie.x)} ${String(ie.y)}`,
    `A ${String(rIn)} ${String(rIn)} 0 ${String(large)} 0 ${String(is_.x)} ${String(is_.y)}`,
    'Z',
  ].join(' ');
}

function appendTrackRing(svg: SVGElement, rOut: number, rIn: number): void {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', describeArc(rOut, rIn, ARC_START_DEG, ARC_START_DEG + FULL_CIRCLE - TRACK_CLOSE_OFFSET));
  path.classList.add('engram-donut-track');
  svg.appendChild(path);
}

interface ArcOpts {
  color: string;
  endDeg: number;
  rIn: number;
  rOut: number;
  startDeg: number;
  svg: SVGElement;
}

function appendArc(opts: ArcOpts): void {
  const { svg, rOut, rIn, startDeg, endDeg, color } = opts;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', describeArc(rOut, rIn, startDeg, endDeg));
  path.style.fill = color;
  path.classList.add('engram-donut-segment');
  svg.appendChild(path);
}

function appendBootstrapArc(svg: SVGElement, startDeg: number, endDeg: number): void {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', describeArc(
    OUTER_R_OUT + BOOTSTRAP_PAD,
    INNER_R_IN - BOOTSTRAP_PAD,
    startDeg,
    endDeg,
  ));
  path.classList.add('engram-donut-bootstrap-arc');
  svg.appendChild(path);

  const midDeg = (startDeg + endDeg) / MIDPOINT_DIVISOR;
  const { x, y } = polarToXY(OUTER_R_OUT + BOOTSTRAP_LABEL_OFFSET, midDeg);
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', String(x));
  text.setAttribute('y', String(y));
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'middle');
  text.classList.add('engram-donut-bootstrap-label');
  text.textContent = 'bootstrap';
  svg.appendChild(text);
}

function appendReclaimArc(svg: SVGElement, startDeg: number, endDeg: number): void {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', describeArc(
    INNER_R_OUT + RECLAIM_PAD,
    INNER_R_IN - RECLAIM_PAD,
    startDeg,
    endDeg,
  ));
  path.classList.add('engram-donut-reclaim-arc');
  svg.appendChild(path);
}
