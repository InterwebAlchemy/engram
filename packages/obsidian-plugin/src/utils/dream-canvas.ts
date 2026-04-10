/**
 * Vanilla TypeScript canvas animation for the Dreams overlay.
 *
 * Adapted from gambit's CanvasBackground (React) — random grid squares
 * that fade in and out over a dark background. Squares naturally decay
 * so the canvas stays dark rather than accumulating brightness.
 */

export class DreamCanvas {
  private animationId: number | null = null;
  private squareOpacities: number[] = [];
  private targetOpacities: number[] = [];
  private lastUpdateTime = 0;
  private nextToggleTime = 0;
  private cols = 0;
  private rows = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly gridSize = 100,
    private readonly maxOpacity = 0.06,
  ) {}

  start(): void {
    this.resize();
    this.resizeHandler = () => this.resize();
    window.addEventListener('resize', this.resizeHandler);
    this.animationId = requestAnimationFrame((t) => this.animate(t));
  }

  stop(): void {
    if (this.resizeHandler) {
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
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;

    const minDim = Math.min(this.canvas.width, this.canvas.height);
    const squareSize = Math.max(1, Math.floor(minDim / this.gridSize));
    this.cols = Math.ceil(this.canvas.width / squareSize);
    this.rows = Math.ceil(this.canvas.height / squareSize);

    const total = this.cols * this.rows;
    const prev = this.squareOpacities.length;
    this.squareOpacities.length = total;
    this.targetOpacities.length = total;
    for (let i = prev; i < total; i++) {
      this.squareOpacities[i] = 0;
      this.targetOpacities[i] = 0;
    }
  }

  private animate(time: number): void {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    if (this.lastUpdateTime === 0) {
      this.lastUpdateTime = time;
      this.nextToggleTime = time + Math.random() * 150 + 25;
    }

    const delta = time - this.lastUpdateTime;
    this.lastUpdateTime = time;

    const total = this.cols * this.rows;
    if (total === 0) {
      this.animationId = requestAnimationFrame((t) => this.animate(t));
      return;
    }

    // Toggle a random square on or off
    if (time >= this.nextToggleTime) {
      const idx = Math.floor(Math.random() * total);
      this.targetOpacities[idx] =
        this.targetOpacities[idx] > 0 ? 0 : this.maxOpacity;
      this.nextToggleTime = time + Math.random() * 200 + 25;
    }

    // Smoothly interpolate toward targets
    const fadeSpeed = 0.004;
    for (let i = 0; i < total; i++) {
      const current = this.squareOpacities[i] ?? 0;
      const target = this.targetOpacities[i] ?? 0;
      const diff = target - current;
      this.squareOpacities[i] =
        Math.abs(diff) > 0.0005
          ? current + diff * fadeSpeed * delta
          : target;
    }

    // Draw
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

    const minDim = Math.min(this.canvas.width, this.canvas.height);
    const squareSize = Math.max(1, Math.floor(minDim / this.gridSize));
    const offsetX = (this.canvas.width - this.cols * squareSize) / 2;
    const offsetY = (this.canvas.height - this.rows * squareSize) / 2;

    for (let i = 0; i < total; i++) {
      const opacity = this.squareOpacities[i] ?? 0;
      if (opacity > 0.0005) {
        const x = offsetX + (i % this.cols) * squareSize;
        const y = offsetY + Math.floor(i / this.cols) * squareSize;
        ctx.fillStyle = `rgba(255, 255, 255, ${opacity})`;
        ctx.fillRect(x, y, squareSize, squareSize);
      }
    }

    this.animationId = requestAnimationFrame((t) => this.animate(t));
  }
}
