import {
  appendBootstrapLabel,
  appendBootstrapOutline,
  appendBootstrapOverlay,
} from './donut-chart-svg';
import { decorateInteractiveElement } from './donut-chart-focus';
import type {
  DonutChartData,
  InteractionState,
} from './donut-chart-types';

interface AngularPlacement {
  endDeg: number;
  startDeg: number;
}

export function renderBootstrapWedge(opts: {
  data: DonutChartData;
  formatCount: (value: number) => string;
  frame: HTMLElement;
  interaction: InteractionState;
  onInteractionChange?: () => void;
  placement: AngularPlacement | null;
  svg: SVGElement;
}): void {
  const {
    data,
    formatCount,
    frame,
    interaction,
    onInteractionChange,
    placement,
    svg,
  } = opts;
  if (placement === null) {
    return;
  }

  const target = { kind: 'bootstrap', key: 'bootstrap' } as const;
  const overlay = appendBootstrapOverlay(svg, placement.startDeg, placement.endDeg);
  const outline = appendBootstrapOutline(svg, placement.startDeg, placement.endDeg);
  const label = appendBootstrapLabel(svg, placement.startDeg, placement.endDeg);
  label.setAttribute(
    'aria-label',
    `Bootstrap context · ~${formatCount(data.bootstrapTokens + data.scratch.bootstrapTokens)} ${data.unit}`,
  );

  const ctx = { frame, interaction, onInteractionChange };
  decorateInteractiveElement(overlay, ctx, target, { bootstrap: true, interactive: false });
  decorateInteractiveElement(outline, ctx, target, { bootstrap: true, interactive: false });
  decorateInteractiveElement(label, ctx, target, { bootstrap: true });
}
