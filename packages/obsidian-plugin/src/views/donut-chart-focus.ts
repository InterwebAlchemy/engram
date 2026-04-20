import type { DonutTarget, InteractionState } from './donut-chart-types';
import { sameDonutTarget } from './donut-chart-types';

interface FocusCtx {
  frame: HTMLElement;
  interaction: InteractionState;
  onInteractionChange?: () => void;
}

interface FocusElementOptions {
  bootstrap?: boolean;
  innerKey?: string;
  interactive?: boolean;
  relatedKey?: string;
}

export function decorateInteractiveElement(
  element: HTMLElement | SVGElement,
  ctx: FocusCtx,
  target: DonutTarget,
  options: FocusElementOptions = {},
): void {
  const { key, kind } = target;
  const {
    bootstrap = false,
    innerKey,
    interactive = true,
    relatedKey,
  } = options;
  const { dataset } = element;
  dataset.engramFocusKind = kind;
  dataset.engramFocusKey = key;
  if (innerKey !== undefined) {
    dataset.engramInnerKey = innerKey;
  }
  if (relatedKey !== undefined) {
    dataset.engramRelatedKey = relatedKey;
  }
  if (bootstrap) {
    dataset.engramBootstrap = 'true';
  }

  if (!interactive) {
    return;
  }

  element.setAttribute('role', 'button');
  element.setAttribute('tabindex', '0');
  element.addEventListener('mouseenter', () => {
    ctx.interaction.setHover(target);
    applyInteractionState(ctx);
  });
  element.addEventListener('mouseleave', () => {
    ctx.interaction.clearHover(target);
    applyInteractionState(ctx);
  });
  element.addEventListener('click', () => {
    ctx.interaction.toggleSelected(target);
    applyInteractionState(ctx);
  });
  element.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent)) {
      return;
    }
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }
    event.preventDefault();
    ctx.interaction.toggleSelected(target);
    applyInteractionState(ctx);
  });
}

export function applyInteractionState(ctx: FocusCtx): void {
  const { frame, interaction } = ctx;
  const { activeTarget, selected } = interaction;
  const interactiveNodes = Array.from(frame.querySelectorAll<HTMLElement | SVGElement>('[data-engram-focus-kind]'));

  for (const node of interactiveNodes) {
    const matchesActive = activeTarget !== null && elementMatchesTarget(node, activeTarget);
    node.classList.toggle('is-emphasized', matchesActive);
    node.classList.toggle('is-dimmed', activeTarget !== null && !matchesActive);

    const { dataset } = node;
    const { engramFocusKind = 'outer', engramFocusKey = '' } = dataset;
    const ownTarget = {
      kind: engramFocusKind === 'bootstrap'
        ? 'bootstrap'
        : (engramFocusKind === 'inner'
          ? 'inner'
          : (engramFocusKind === 'overlay' ? 'overlay' : 'outer')),
      key: engramFocusKey,
    } satisfies DonutTarget;
    node.setAttribute('aria-pressed', String(sameDonutTarget(selected, ownTarget)));
  }
  ctx.onInteractionChange?.();
}

function elementMatchesTarget(element: HTMLElement | SVGElement, target: DonutTarget): boolean {
  const { dataset } = element;
  const {
    engramFocusKind,
    engramFocusKey,
    engramBootstrap,
    engramInnerKey,
    engramRelatedKey,
  } = dataset;

  if (target.kind === 'bootstrap') {
    return engramFocusKind === 'bootstrap' || engramBootstrap === 'true';
  }
  if (target.kind === 'inner') {
    return (engramFocusKind === 'inner' && engramFocusKey === target.key) || engramInnerKey === target.key;
  }
  if (target.kind === 'overlay') {
    return (engramFocusKind === 'overlay' && engramFocusKey === target.key) || engramRelatedKey === target.key;
  }
  return engramFocusKind === 'outer' && engramFocusKey === target.key;
}
