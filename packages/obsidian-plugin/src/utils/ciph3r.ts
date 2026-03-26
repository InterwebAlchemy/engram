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
    this.intervalId = window.setInterval(() => this.tick(), this.speed);
  }

  /** Stops the animation and restores the original target text. Idempotent. */
  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.el.textContent = this.target;
    this.current = this.target;
  }

  private tick(): void {
    const chars = this.current.split('');

    if (this.phase === 'encode') {
      let count = 0;
      for (let i = 0; i < this.target.length && count < MAX_CHARS_PER_TICK; i++) {
        if (chars[i] === this.target[i] && Math.random() > REVEAL_PROBABILITY) {
          chars[i] = randomChar();
          count++;
        }
      }
      this.current = chars.join('');

      // Switch to decode once every position differs from the target
      const fullyEncoded = this.current.split('').every((c, i) => c !== this.target[i]);
      if (fullyEncoded) {
        this.phase = 'decode';
        this.current = randomizeText(this.target);
      }
    } else {
      let count = 0;
      for (let i = 0; i < this.target.length && count < MAX_CHARS_PER_TICK; i++) {
        if (chars[i] !== this.target[i] && Math.random() > REVEAL_PROBABILITY) {
          chars[i] = this.target[i];
          count++;
        }
      }
      this.current = chars.join('');

      // Switch to encode once fully decoded
      if (this.current === this.target) {
        this.phase = 'encode';
      }
    }

    this.el.textContent = this.current;
  }
}
