import { appendBootstrapInstructionsArc } from './donut-chart-svg';
import {
  bindTooltip,
  bootstrapInstructionsTooltipBody,
} from './donut-chart-legend';
import { decorateInteractiveElement } from './donut-chart-focus';
import { BOOTSTRAP_INSTRUCTIONS_TARGET_KEY } from './donut-chart-metrics';
import type {
  DonutChartData,
  InteractionState,
} from './donut-chart-types';

interface AngularPlacement {
  endDeg: number;
  startDeg: number;
}

export function renderBootstrapInstructionsArc(opts: {
  data: DonutChartData;
  formatCount: (value: number) => string;
  frame: HTMLElement;
  interaction: InteractionState;
  onInteractionChange?: () => void;
  placement: AngularPlacement | null;
  svg: SVGElement;
  tooltip: HTMLElement;
  wrapper: HTMLElement;
}): void {
  const {
    data: { bootstrapInstructions },
    formatCount,
    frame,
    interaction,
    onInteractionChange,
    placement,
    svg,
    tooltip,
    wrapper,
  } = opts;
  if (!bootstrapInstructions.exists || bootstrapInstructions.tokens <= 0 || placement === null) {
    return;
  }

  const arc = appendBootstrapInstructionsArc(
    svg,
    placement.startDeg,
    placement.endDeg,
    bootstrapInstructions.color,
  );
  bindTooltip(
    arc,
    { tooltip, wrapper },
    () => bootstrapInstructionsTooltipBody(formatCount, bootstrapInstructions.tokens),
  );
  decorateInteractiveElement(
    arc,
    { frame, interaction, onInteractionChange },
    { kind: 'overlay', key: BOOTSTRAP_INSTRUCTIONS_TARGET_KEY },
    {
      bootstrap: true,
      relatedKey: 'bootstrap',
    },
  );
}
