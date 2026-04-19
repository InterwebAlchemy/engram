import { setIcon } from 'obsidian';
import type { ModelOption } from './dreams-view-support';

const NARRATIVE_REUSE_VALUE = '';

interface RenderDreamToolbarOptions {
  parent: HTMLElement;
  onRefresh: () => void;
}

interface RenderDreamControlsOptions {
  parent: HTMLElement;
  options: ModelOption[];
  selectedProviderId: string;
  selectedModelId: string;
  narrativeProviderId: string;
  narrativeModelId: string;
  onDream: () => void;
  onModelChange: (providerId: string, modelId: string) => void;
  onNarrativeChange: (providerId: string, modelId: string) => void;
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
  renderAnalysisPicker(form, options);
  renderNarrativePicker(form, options);

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

function renderAnalysisPicker(
  form: HTMLElement,
  options: RenderDreamControlsOptions,
): void {
  const field = form.createDiv({ cls: 'engram-dreams-controls-field' });
  field.createEl('label', {
    cls: 'engram-dreams-controls-label',
    text: 'Analysis',
  });
  const modelSelect = field.createEl('select', {
    cls: 'engram-filter-select',
    attr: { 'aria-label': 'Dreams analysis provider and model' },
  });

  if (options.options.length === 0) {
    modelSelect.createEl('option', {
      value: '',
      text: 'No enabled models. Configure one in Settings.',
    });
    modelSelect.disabled = true;
    return;
  }

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

function renderNarrativePicker(
  form: HTMLElement,
  options: RenderDreamControlsOptions,
): void {
  const field = form.createDiv({ cls: 'engram-dreams-controls-field' });
  field.createEl('label', {
    cls: 'engram-dreams-controls-label',
    text: 'Narrative',
  });
  const narrativeSelect = field.createEl('select', {
    cls: 'engram-filter-select',
    attr: { 'aria-label': 'Dreams narrative provider and model' },
  });

  narrativeSelect.createEl('option', {
    value: NARRATIVE_REUSE_VALUE,
    text: 'Same as analysis',
  });
  for (const option of options.options) {
    narrativeSelect.createEl('option', {
      value: `${option.providerId}::${option.modelId}`,
      text: `${option.providerName} - ${option.modelName}`,
    });
  }

  const reuseNarrative = options.narrativeProviderId.length === 0
    || options.narrativeModelId.length === 0;
  narrativeSelect.value = reuseNarrative
    ? NARRATIVE_REUSE_VALUE
    : `${options.narrativeProviderId}::${options.narrativeModelId}`;
  narrativeSelect.disabled = options.options.length === 0;
  narrativeSelect.addEventListener('change', () => {
    if (narrativeSelect.value === NARRATIVE_REUSE_VALUE) {
      options.onNarrativeChange('', '');
      return;
    }
    const [providerId = '', modelId = ''] = narrativeSelect.value.split('::');
    options.onNarrativeChange(providerId, modelId);
  });
}
