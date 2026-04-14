/**
 * Vanilla TypeScript canvas animation for the Dreams overlay.
 *
 * Adapted from gambit's CanvasBackground (React) — random grid squares
 * that fade in and out over a dark background. Squares naturally decay
 * so the canvas stays dark rather than accumulating brightness.
 */

const DEFAULT_GRID_SIZE = 100;
const DEFAULT_MAX_OPACITY = 0.06;
const INITIAL_TOGGLE_MAX_MS = 150;
const TOGGLE_DELAY_MS = 25;
const NEXT_TOGGLE_MAX_MS = 200;
const FADE_SPEED = 0.004;
const MIN_OPACITY_DELTA = 0.0005;
const OFFSET_DIVISOR = 2;

export class DreamCanvas {
  private animationId: number | null = null;
  private readonly squareOpacities: number[] = [];
  private targetOpacities: number[] = [];
  private lastUpdateTime = 0;
  private nextToggleTime = 0;
  private cols = 0;
  private rows = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gridSize = DEFAULT_GRID_SIZE,
    private readonly maxOpacity = DEFAULT_MAX_OPACITY,
  ) {}

  start(): void {
    this.resize();
    this.resizeHandler = () => { this.resize(); };
    window.addEventListener('resize', this.resizeHandler);
    this.animationId = requestAnimationFrame((t) => { this.animate(t); });
  }

  stop(): void {
    if (this.resizeHandler !== null) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
  }

  private resizeHandler: (() => void) | null = null;

  private resize(): void {
    const { canvas } = this;
    const rect = canvas.getBoundingClientRect();
    const {
      width,
      height,
    } = rect;
    canvas.width = width;
    canvas.height = height;

    const minDim = Math.min(canvas.width, canvas.height);
    const squareSize = Math.max(1, Math.floor(minDim / this.gridSize));
    this.cols = Math.ceil(canvas.width / squareSize);
    this.rows = Math.ceil(canvas.height / squareSize);

    const total = this.cols * this.rows;
    const {
      squareOpacities,
      targetOpacities,
    } = this;
    const { length: previousLength } = squareOpacities;
    squareOpacities.length = total;
    targetOpacities.length = total;
    for (let index = previousLength; index < total; index += 1) {
      squareOpacities[index] = 0;
      targetOpacities[index] = 0;
    }
  }

  private animate(time: number): void {
    const ctx = this.canvas.getContext('2d');
    if (ctx === null) {
      return;
    }

    if (this.lastUpdateTime === 0) {
      this.lastUpdateTime = time;
      this.nextToggleTime = time + Math.random() * INITIAL_TOGGLE_MAX_MS + TOGGLE_DELAY_MS;
    }

    const delta = time - this.lastUpdateTime;
    this.lastUpdateTime = time;

    const total = this.cols * this.rows;
    if (total === 0) {
      this.requestNextFrame();
      return;
    }

    this.updateToggleTargets(time, total);
    this.interpolateSquareOpacities(total, delta);
    this.drawSquares(ctx, total);
    this.requestNextFrame();
  }

  private requestNextFrame(): void {
    this.animationId = requestAnimationFrame((timestamp) => { this.animate(timestamp); });
  }

  private updateToggleTargets(time: number, total: number): void {
    if (time < this.nextToggleTime) {
      return;
    }

    const targetIndex = Math.floor(Math.random() * total);
    this.targetOpacities[targetIndex] =
      this.targetOpacities[targetIndex] > 0 ? 0 : this.maxOpacity;
    this.nextToggleTime = time + Math.random() * NEXT_TOGGLE_MAX_MS + TOGGLE_DELAY_MS;
  }

  private interpolateSquareOpacities(total: number, delta: number): void {
    const {
      squareOpacities,
      targetOpacities,
    } = this;
    for (let index = 0; index < total; index += 1) {
      const currentOpacity = squareOpacities.at(index) ?? 0;
      const targetOpacity = targetOpacities.at(index) ?? 0;
      const opacityDelta = targetOpacity - currentOpacity;
      squareOpacities[index] =
        Math.abs(opacityDelta) > MIN_OPACITY_DELTA
          ? currentOpacity + opacityDelta * FADE_SPEED * delta
          : targetOpacity;
    }
  }

  private drawSquares(ctx: CanvasRenderingContext2D, total: number): void {
    const { canvas } = this;
    const context = ctx;
    context.clearRect(0, 0, canvas.width, canvas.height);

    const minDim = Math.min(canvas.width, canvas.height);
    const squareSize = Math.max(1, Math.floor(minDim / this.gridSize));
    const offsetX = (canvas.width - this.cols * squareSize) / OFFSET_DIVISOR;
    const offsetY = (canvas.height - this.rows * squareSize) / OFFSET_DIVISOR;

    const { squareOpacities } = this;
    for (let index = 0; index < total; index += 1) {
      const opacity = squareOpacities.at(index) ?? 0;
      if (opacity <= MIN_OPACITY_DELTA) {
        continue;
      }

      const x = offsetX + (index % this.cols) * squareSize;
      const y = offsetY + Math.floor(index / this.cols) * squareSize;
      context.fillStyle = `rgba(255, 255, 255, ${opacity})`;
      context.fillRect(x, y, squareSize, squareSize);
    }
  }
}
