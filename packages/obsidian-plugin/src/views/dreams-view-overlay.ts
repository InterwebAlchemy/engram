import { DreamCanvas } from '../utils/dream-canvas';

interface RenderDreamerWordsOverlayOptions {
  parent: HTMLElement;
  words: string;
  dismissText: string;
  onDismiss: () => void;
}

export function renderDreamerWordsOverlay(options: RenderDreamerWordsOverlayOptions): DreamCanvas {
  const overlay = options.parent.createDiv({
    cls: 'engram-dreams-overlay engram-dreams-overlay-words',
  });
  const canvas = overlay.createEl('canvas', { cls: 'engram-dreams-overlay-canvas' });
  const dreamCanvas = new DreamCanvas(canvas);
  dreamCanvas.start();

  const center = overlay.createDiv({
    cls: 'engram-dreams-overlay-center engram-dreams-overlay-card',
  });
  center.createEl('p', {
    cls: 'engram-dreams-overlay-dream-text',
    text: options.words,
  });
  const dismissButton = center.createEl('button', {
    cls: 'engram-dreams-overlay-dismiss',
    text: options.dismissText,
  });
  dismissButton.addEventListener('click', options.onDismiss);
  return dreamCanvas;
}
