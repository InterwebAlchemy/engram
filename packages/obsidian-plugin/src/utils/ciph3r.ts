/**
 * Vanilla TypeScript port of the core ciph3r-text animation logic.
 *
 * Ported from https://github.com/InterwebAlchemy/ciph3r-text (MIT)
 * Original: React component using useInterval + useState.
 * This version: plain class + window.setInterval, no React dependency.
 *
 * Cycles between encoding ("Thinking..." → random chars) and decoding
 * (random chars → "Thinking...") to produce the cipher-text loading effect.
 */

const BASE_PRINTABLE_CHARACTERS =
  `!"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_` +
  `abcdefghijklmnopqrstuvwxyz{|}~`;

const DEFAULT_SPEED = 80;  // ms per tick (matches ciph3r-text scramble speed)
const MAX_CHARS_PER_TICK = 3;
const REVEAL_PROBABILITY = 0.4; // threshold for Math.random() comparison

function randomChar(chars = BASE_PRINTABLE_CHARACTERS): string {
  return chars[Math.floor(Math.random() * chars.length)];
}

function randomizeText(text: string): string {
  return text.split('').map(() => randomChar()).join('');
}

type Phase = 'encode' | 'decode';

/**
 * Animates a DOM element's text content by cycling encode → decode → encode.
 *
 * During encode: progressively replaces characters with random printable chars.
 * During decode: progressively reveals the original target text.
 *
 * Usage:
 *   const animator = new Ciph3rTextAnimator(spanEl, 'Thinking...');
 *   animator.start();
 *   // later…
 *   animator.stop(); // restores original text and clears interval
 */
export class Ciph3rTextAnimator {
  private current: string;
  private phase: Phase = 'decode';
  private intervalId: number | null = null;

  constructor(
    private readonly el: HTMLElement,
    private readonly target: string,
    private readonly speed = DEFAULT_SPEED,
  ) {
    this.current = target;
    this.el.textContent = target;
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = window.setInterval(() => { this.tick(); }, this.speed);
  }

  /** Stops the animation and restores the original target text. Idempotent. */
  stop(): void {
    const {
      el,
      target,
    } = this;
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    el.textContent = target;
    this.current = target;
  }

  private tick(): void {
    const { current, el } = this;
    const chars = current.split('');
    this.current = this.phase === 'encode'
      ? this.encodeStep(chars)
      : this.decodeStep(chars);
    const { current: nextValue } = this;
    el.textContent = nextValue;
  }

  private encodeStep(chars: string[]): string {
    const { target } = this;
    const nextChars = mutateCharacters(chars, target, (currentCharacter, nextCharacter) => (
      currentCharacter === nextCharacter &&
      Math.random() > REVEAL_PROBABILITY
    ), () => randomChar());

    const nextValue = nextChars.join('');
    const fullyEncoded = nextValue.split('').every((character, index) => character !== target[index]);
    if (fullyEncoded) {
      this.phase = 'decode';
      return randomizeText(target);
    }

    return nextValue;
  }

  private decodeStep(chars: string[]): string {
    const { target } = this;
    const nextChars = mutateCharacters(chars, target, (currentCharacter, nextCharacter) => (
      currentCharacter !== nextCharacter &&
      Math.random() > REVEAL_PROBABILITY
    ), (_currentCharacter, nextCharacter) => nextCharacter);

    const nextValue = nextChars.join('');
    if (nextValue === target) {
      this.phase = 'encode';
    }

    return nextValue;
  }
}

function mutateCharacters(
  chars: string[],
  target: string,
  shouldMutate: (currentCharacter: string, nextCharacter: string) => boolean,
  nextCharacterFor: (currentCharacter: string, nextCharacter: string) => string,
): string[] {
  const nextChars = [...chars];
  let count = 0;
  for (let index = 0; index < target.length && count < MAX_CHARS_PER_TICK; index += 1) {
    const currentCharacter = nextChars[index] ?? '';
    const nextCharacter = target[index] ?? '';
    if (shouldMutate(currentCharacter, nextCharacter)) {
      nextChars[index] = nextCharacterFor(currentCharacter, nextCharacter);
      count += 1;
    }
  }

  return nextChars;
}
