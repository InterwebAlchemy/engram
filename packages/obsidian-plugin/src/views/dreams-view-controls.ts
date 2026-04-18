import { setIcon } from 'obsidian';
import type { ModelOption } from './dreams-view-support';

interface RenderDreamToolbarOptions {
  parent: HTMLElement;
  onCreateSnapshot: () => void;
  onRefresh: () => void;
}

interface RenderDreamControlsOptions {
  parent: HTMLElement;
  options: ModelOption[];
  selectedProviderId: string;
  selectedModelId: string;
  onDream: () => void;
  onModelChange: (providerId: string, modelId: string) => void;
  onPowerNap: () => void;
}

export function renderDreamToolbar(options: RenderDreamToolbarOptions): void {
  const titleGroup = options.parent.createDiv({ cls: 'engram-dreams-toolbar-copy' });
  titleGroup.createEl('h3', { text: 'Dreams dashboard' });
  titleGroup.createEl('p', {
    cls: 'setting-item-description',
    text: 'Inspect vault health, plan memory cleanup, and run Dreams from the place where the memories live.',
  });

  const actions = options.parent.createDiv({ cls: 'engram-dreams-toolbar-actions' });

  const refreshButton = actions.createEl('button', {
    cls: 'engram-toolbar-btn',
    attr: { 'aria-label': 'Refresh Dreams dashboard' },
  });
  setIcon(refreshButton, 'refresh-cw');
  refreshButton.addEventListener('click', options.onRefresh);

  const snapshotButton = actions.createEl('button', {
    cls: 'mod-cta',
    text: 'Create snapshot',
  });
  snapshotButton.addEventListener('click', options.onCreateSnapshot);
}

export function renderDreamControls(options: RenderDreamControlsOptions): void {
  const section = options.parent.createDiv({ cls: 'engram-dreams-controls' });
  const copy = section.createDiv({ cls: 'engram-dreams-controls-copy' });
  copy.createEl('h4', { text: 'Dream' });
  copy.createDiv({
    cls: 'engram-dreams-section-description',
    text: 'Power Nap runs heuristic cleanup only. Dream continues into model-guided consolidation. A snapshot is created before either path changes anything.',
  });

  const form = section.createDiv({ cls: 'engram-dreams-controls-form' });
  const modelSelect = form.createEl('select', {
    cls: 'engram-filter-select',
    attr: { 'aria-label': 'Dreams provider and model' },
  });

  if (options.options.length === 0) {
    modelSelect.createEl('option', {
      value: '',
      text: 'No enabled models. Configure one in Settings.',
    });
    modelSelect.disabled = true;
  } else {
    for (const option of options.options) {
      modelSelect.createEl('option', {
        value: `${option.providerId}::${option.modelId}`,
        text: `${option.providerName} - ${option.modelName}`,
      });
    }
    modelSelect.value = `${options.selectedProviderId}::${options.selectedModelId}`;
    modelSelect.addEventListener('change', () => {
      const [providerId = '', modelId = ''] = modelSelect.value.split('::');
      options.onModelChange(providerId, modelId);
    });
  }

  const dreamButton = form.createEl('button', {
    cls: 'mod-cta',
    text: 'Dream',
  });
  dreamButton.disabled = options.options.length === 0;
  dreamButton.addEventListener('click', options.onDream);

  const powerNapButton = form.createEl('button', {
    text: 'Power Nap',
  });
  powerNapButton.addEventListener('click', options.onPowerNap);
}
