import {
  Modal,
  setIcon,
  type App,
} from 'obsidian';
import type { DreamSelectionState } from './dreams-view-selection';
import type { ModelOption } from './dreams-view-support';

const NARRATIVE_REUSE_VALUE = '';

interface RenderDreamToolbarOptions {
  parent: HTMLElement;
  onRefresh: () => void;
}

interface RenderDreamControlsOptions {
  hasModels: boolean;
  onDream: () => void;
  onPowerNap: () => void;
  parent: HTMLElement;
}

interface ConfirmDreamRunOptions {
  app: App;
  initialState: DreamSelectionState;
  onConfirm: (state: DreamSelectionState) => void;
  options: ModelOption[];
}

export function renderDreamToolbar(options: RenderDreamToolbarOptions): void {
  const actions = options.parent.createDiv({ cls: 'engram-dreams-toolbar-actions' });
  const refreshButton = actions.createEl('button', {
    cls: 'engram-toolbar-btn',
    attr: { 'aria-label': 'Refresh overview' },
  });
  setIcon(refreshButton, 'refresh-cw');
  refreshButton.addEventListener('click', options.onRefresh);
}

export function renderDreamControls(options: RenderDreamControlsOptions): void {
  const section = options.parent.createDiv({ cls: 'engram-dreams-controls' });

  const actions = section.createDiv({ cls: 'engram-dreams-controls-form' });
  const powerNapButton = actions.createEl('button', {
    text: 'Power Nap',
  });
  powerNapButton.addEventListener('click', options.onPowerNap);

  const dreamButton = actions.createEl('button', {
    cls: 'mod-cta',
    text: 'Dream',
  });
  dreamButton.disabled = !options.hasModels;
  dreamButton.addEventListener('click', options.onDream);
}

export function confirmDreamRun(options: ConfirmDreamRunOptions): void {
  const {
    app,
    initialState,
    onConfirm,
    options: modelOptions,
  } = options;
  const modal = new DreamRunConfirmModal(
    app,
    modelOptions,
    initialState,
    onConfirm,
  );
  modal.open();
}

class DreamRunConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly modelOptions: ModelOption[],
    private readonly initialState: DreamSelectionState,
    private readonly onConfirm: (value: DreamSelectionState) => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('engram-dreams-confirm-modal');

    contentEl.createEl('h4', { text: 'Start Dream?' });
    contentEl.createEl('p', {
      cls: 'engram-dreams-section-description',
      text: 'A safety snapshot is created before the Dream changes anything. Confirm the model pairing for this run below.',
    });

    const form = contentEl.createDiv({ cls: 'engram-dreams-confirm-form' });
    const analysisSelect = createModelSelect(
      form,
      'Analysis model',
      this.modelOptions,
      `${this.initialState.analysisSelection.providerId}::${this.initialState.analysisSelection.modelId}`,
    );
    const narrativeSelect = createNarrativeSelect(
      form,
      this.modelOptions,
      this.initialState,
    );

    const actions = contentEl.createDiv({ cls: 'engram-dreams-confirm-actions' });
    const cancelButton = actions.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.close();
    });

    const confirmButton = actions.createEl('button', {
      cls: 'mod-cta',
      text: 'Begin Dream',
    });
    confirmButton.addEventListener('click', () => {
      const [analysisProviderId = '', analysisModelId = ''] = analysisSelect.value.split('::');
      const useAnalysisNarrative = narrativeSelect.value === NARRATIVE_REUSE_VALUE;
      const [narrativeProviderId = '', narrativeModelId = ''] = useAnalysisNarrative
        ? ['', '']
        : narrativeSelect.value.split('::');
      this.onConfirm({
        analysisSelection: {
          providerId: analysisProviderId,
          modelId: analysisModelId,
        },
        narrativeSelection: useAnalysisNarrative
          ? { providerId: '', modelId: '' }
          : {
            providerId: narrativeProviderId,
            modelId: narrativeModelId,
          },
      });
      this.close();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

function createModelSelect(
  parent: HTMLElement,
  label: string,
  options: ModelOption[],
  selectedValue: string,
): HTMLSelectElement {
  const field = parent.createDiv({ cls: 'engram-dreams-controls-field' });
  field.createEl('label', {
    cls: 'engram-dreams-controls-label',
    text: label,
  });
  const select = field.createEl('select', {
    cls: 'engram-filter-select',
  });
  for (const option of options) {
    select.createEl('option', {
      value: `${option.providerId}::${option.modelId}`,
      text: `${option.providerName} - ${option.modelName}`,
    });
  }
  select.value = selectedValue;
  return select;
}

function createNarrativeSelect(
  parent: HTMLElement,
  options: ModelOption[],
  state: DreamSelectionState,
): HTMLSelectElement {
  const field = parent.createDiv({ cls: 'engram-dreams-controls-field' });
  field.createEl('label', {
    cls: 'engram-dreams-controls-label',
    text: 'Narrative model',
  });
  const select = field.createEl('select', {
    cls: 'engram-filter-select',
  });
  select.createEl('option', {
    value: NARRATIVE_REUSE_VALUE,
    text: 'Same as analysis',
  });
  for (const option of options) {
    select.createEl('option', {
      value: `${option.providerId}::${option.modelId}`,
      text: `${option.providerName} - ${option.modelName}`,
    });
  }

  const reuseNarrative = state.narrativeSelection.providerId.length === 0
    || state.narrativeSelection.modelId.length === 0;
  select.value = reuseNarrative
    ? NARRATIVE_REUSE_VALUE
    : `${state.narrativeSelection.providerId}::${state.narrativeSelection.modelId}`;
  return select;
}
