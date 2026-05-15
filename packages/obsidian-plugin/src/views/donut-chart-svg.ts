/* SVG primitives + geometry constants for the donut chart. */

export const SVG_NS = 'http://www.w3.org/2000/svg';
export const DONUT_SIZE = 280;
export const DONUT_HALF = 140;
export const DONUT_CX = DONUT_HALF;
export const DONUT_CY = DONUT_HALF;
export const OUTER_R_OUT = 122;
export const OUTER_R_IN = 94;
export const INNER_R_OUT = 88;
export const INNER_R_IN = 64;
export const BOOTSTRAP_INSTRUCTIONS_R_OUT = 56;
export const BOOTSTRAP_INSTRUCTIONS_R_IN = 50;
export const ARC_GAP_DEG = 1.5;
export const SECTION_GAP_DEG = 3;
export const ARC_START_DEG = -90;
export const HALF_CIRCLE = 180;
export const FULL_CIRCLE = 360;
export const MIDPOINT_DIVISOR = 2;

const DEG_TO_RAD = Math.PI / HALF_CIRCLE;
const TRACK_CLOSE_OFFSET = 0.01;
const BOOTSTRAP_OVERLAY_INNER_PAD = 6;
const BOOTSTRAP_OUTLINE_INNER_PAD = 5;
const BOOTSTRAP_OUTLINE_OUTER_PAD = 2;
const BOOTSTRAP_LABEL_OFFSET = 20;
const RECLAIM_PAD = 2;
const CONTEXT_CAP_OUTER_PAD = 1.5;
const CONTEXT_CAP_THICKNESS = 7;
const THREAD_BOOTSTRAP_OVERLAY_OUTER_PAD = 1;
const THREAD_BOOTSTRAP_OVERLAY_INNER_PAD = 1;
const THREAD_BOOTSTRAP_OUTLINE_OUTER_PAD = 0.25;
const THREAD_BOOTSTRAP_OUTLINE_INNER_PAD = 0.25;

export function createSvg(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${String(DONUT_SIZE)} ${String(DONUT_SIZE)}`);
  svg.classList.add('engram-donut-svg');
  return svg;
}

export function polarToXY(r: number, angleDeg: number): { x: number; y: number } {
  const rad = angleDeg * DEG_TO_RAD;
  return { x: DONUT_CX + r * Math.cos(rad), y: DONUT_CY + r * Math.sin(rad) };
}

export function describeArc(
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

export function appendTrackRing(svg: SVGElement, rOut: number, rIn: number): void {
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', describeArc(rOut, rIn, ARC_START_DEG, ARC_START_DEG + FULL_CIRCLE - TRACK_CLOSE_OFFSET));
  path.classList.add('engram-donut-track');
  svg.appendChild(path);
}

export interface ArcOpts {
  color: string;
  endDeg: number;
  rIn: number;
  rOut: number;
  startDeg: number;
  svg: SVGElement;
}

export function appendArc(opts: ArcOpts): SVGPathElement {
  const { svg, rOut, rIn, startDeg, endDeg, color } = opts;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', describeArc(rOut, rIn, startDeg, endDeg));
  path.style.fill = color;
  path.classList.add('engram-donut-segment');
  svg.appendChild(path);
  return path;
}

/**
 * Dashed outline around the full two-ring bootstrap wedge.
 */
export function appendBootstrapOutline(svg: SVGElement, startDeg: number, endDeg: number): SVGPathElement {
  return appendOverlayPath(svg, {
    classes: ['engram-donut-bootstrap-arc'],
    endDeg,
    rIn: INNER_R_IN - BOOTSTRAP_OUTLINE_INNER_PAD,
    rOut: OUTER_R_OUT + BOOTSTRAP_OUTLINE_OUTER_PAD,
    startDeg,
  });
}

export function appendBootstrapOverlay(svg: SVGElement, startDeg: number, endDeg: number): SVGPathElement {
  return appendOverlayPath(svg, {
    classes: ['engram-donut-bootstrap-overlay'],
    endDeg,
    rIn: INNER_R_IN - BOOTSTRAP_OVERLAY_INNER_PAD,
    rOut: OUTER_R_OUT + BOOTSTRAP_OUTLINE_OUTER_PAD,
    startDeg,
  });
}

export function appendThreadBootstrapOutline(
  svg: SVGElement,
  startDeg: number,
  endDeg: number,
  thicknessRatio: number,
): SVGPathElement {
  return appendThreadBootstrapBand(svg, {
    className: 'engram-donut-thread-bootstrap-outline',
    endDeg,
    padIn: THREAD_BOOTSTRAP_OUTLINE_INNER_PAD,
    padOut: THREAD_BOOTSTRAP_OUTLINE_OUTER_PAD,
    startDeg,
    strokeOnly: true,
    thicknessRatio,
  });
}

export function appendThreadBootstrapOverlay(
  svg: SVGElement,
  startDeg: number,
  endDeg: number,
  thicknessRatio: number,
): SVGPathElement {
  return appendThreadBootstrapBand(svg, {
    className: 'engram-donut-thread-bootstrap-overlay',
    endDeg,
    padIn: THREAD_BOOTSTRAP_OVERLAY_INNER_PAD,
    padOut: THREAD_BOOTSTRAP_OVERLAY_OUTER_PAD,
    startDeg,
    strokeOnly: false,
    thicknessRatio,
  });
}

export function appendBootstrapLabel(svg: SVGElement, startDeg: number, endDeg: number): SVGTextElement {
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
  return text;
}

export function appendBootstrapInstructionsArc(
  svg: SVGElement,
  startDeg: number,
  endDeg: number,
  color: string,
): SVGPathElement {
  const path = appendArc({
    svg,
    rOut: BOOTSTRAP_INSTRUCTIONS_R_OUT,
    rIn: BOOTSTRAP_INSTRUCTIONS_R_IN,
    startDeg,
    endDeg,
    color,
  });
  path.classList.add('engram-donut-bootstrap-instructions-arc');
  return path;
}

export function appendReclaimArc(svg: SVGElement, startDeg: number, endDeg: number): void {
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

export function appendContextCap(svg: SVGElement, startDeg: number, endDeg: number): SVGPathElement {
  return appendOverlayPath(svg, {
    classes: ['engram-donut-context-cap'],
    endDeg,
    rIn: OUTER_R_OUT - CONTEXT_CAP_THICKNESS,
    rOut: OUTER_R_OUT + CONTEXT_CAP_OUTER_PAD,
    startDeg,
  });
}

function appendOverlayPath(
  svg: SVGElement,
  opts: {
    classes: string[];
    endDeg: number;
    rIn: number;
    rOut: number;
    startDeg: number;
  },
): SVGPathElement {
  const {
    classes,
    endDeg,
    rIn,
    rOut,
    startDeg,
  } = opts;
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', describeArc(rOut, rIn, startDeg, endDeg));
  path.classList.add(...classes);
  svg.appendChild(path);
  return path;
}

function appendThreadBootstrapBand(
  svg: SVGElement,
  opts: {
    className: 'engram-donut-thread-bootstrap-outline' | 'engram-donut-thread-bootstrap-overlay';
    endDeg: number;
    padIn: number;
    padOut: number;
    startDeg: number;
    strokeOnly: boolean;
    thicknessRatio: number;
  },
): SVGPathElement {
  const {
    className,
    endDeg,
    padIn,
    padOut,
    startDeg,
    strokeOnly,
    thicknessRatio,
  } = opts;
  const rOut = OUTER_R_OUT - padOut;
  const minInner = INNER_R_IN + padIn;
  const bandThickness = Math.max(rOut - minInner, 0) * clampRatio(thicknessRatio);
  const rIn = Math.max(rOut - bandThickness, minInner);

  return appendOverlayPath(svg, {
    classes: strokeOnly
      ? ['engram-donut-bootstrap-arc', className]
      : ['engram-donut-bootstrap-overlay', className],
    endDeg,
    rIn,
    rOut,
    startDeg,
  });
}

function clampRatio(value: number): number {
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}
