export interface ChatInputRefs {
  readonly inputEl: HTMLTextAreaElement;
  readonly systemPromptEl: HTMLTextAreaElement;
  readonly temperatureEl: HTMLInputElement;
  readonly maxTokensEl: HTMLInputElement;
  readonly combinedModelSelect: HTMLSelectElement;
  readonly sendBtn: HTMLButtonElement;
  readonly cancelBtn: HTMLButtonElement;
}

export interface ChatInputOverrides {
  readonly systemPrompt: string;
  readonly temperature: string;
  readonly maxTokens: string;
}

export interface ChatInputCallbacks {
  readonly initialOverrides: ChatInputOverrides;
  readonly defaultTemperature: number;
  readonly defaultMaxTokens: number;
  readonly onSystemPromptChange: (value: string) => void;
  readonly onTemperatureChange: (value: string) => void;
  readonly onMaxTokensChange: (value: string) => void;
  readonly onSend: () => void;
  readonly onCancel: () => void;
  readonly onModelChange: () => void;
  readonly onEnterSubmit: () => void;
}

export function renderChatInputArea(
  parent: HTMLElement,
  cb: ChatInputCallbacks,
): ChatInputRefs {
  const inputContainer = parent.createDiv({ cls: 'engram-input-container' });

  const inputEl = inputContainer.createEl('textarea', {
    cls: 'engram-input',
    attr: { placeholder: 'Type a message…', rows: '3' },
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      cb.onEnterSubmit();
    }
  });

  const params = renderParameters(inputContainer, cb);
  const footer = renderFooter(inputContainer, cb);

  return {
    inputEl,
    systemPromptEl: params.systemPromptEl,
    temperatureEl: params.temperatureEl,
    maxTokensEl: params.maxTokensEl,
    combinedModelSelect: footer.combinedModelSelect,
    sendBtn: footer.sendBtn,
    cancelBtn: footer.cancelBtn,
  };
}

interface ParameterRefs {
  readonly systemPromptEl: HTMLTextAreaElement;
  readonly temperatureEl: HTMLInputElement;
  readonly maxTokensEl: HTMLInputElement;
}

function renderParameters(parent: HTMLElement, cb: ChatInputCallbacks): ParameterRefs {
  const { initialOverrides, defaultTemperature, defaultMaxTokens } = cb;
  const { systemPrompt, temperature, maxTokens } = initialOverrides;

  const details = parent.createEl('details', { cls: 'engram-params-details' });
  details.createEl('summary', { cls: 'engram-params-summary', text: 'Parameters' });
  const grid = details.createDiv({ cls: 'engram-params-grid' });

  grid.createEl('label', {
    cls: 'engram-params-label',
    text: 'System prompt',
    attr: { for: 'engram-system-prompt' },
  });
  const systemPromptEl = grid.createEl('textarea', {
    cls: 'engram-params-textarea',
    attr: {
      id: 'engram-system-prompt',
      placeholder: 'Leave empty to use the default preamble from Settings…',
      rows: '3',
    },
  });
  systemPromptEl.value = systemPrompt;
  systemPromptEl.addEventListener('input', () => {
    const { value } = systemPromptEl;
    cb.onSystemPromptChange(value);
  });

  const numRow = grid.createDiv({ cls: 'engram-params-row' });

  const tempGroup = numRow.createDiv({ cls: 'engram-params-field' });
  tempGroup.createEl('label', {
    cls: 'engram-params-label',
    text: 'Temperature',
    attr: { for: 'engram-temperature' },
  });
  const temperatureEl = tempGroup.createEl('input', {
    cls: 'engram-params-input',
    attr: {
      id: 'engram-temperature',
      type: 'number',
      step: '0.1',
      min: '0',
      max: '2',
      placeholder: `default (${String(defaultTemperature)})`,
    },
  });
  temperatureEl.value = temperature;
  temperatureEl.addEventListener('input', () => {
    const { value } = temperatureEl;
    cb.onTemperatureChange(value);
  });

  const tokensGroup = numRow.createDiv({ cls: 'engram-params-field' });
  tokensGroup.createEl('label', {
    cls: 'engram-params-label',
    text: 'Max tokens',
    attr: { for: 'engram-max-tokens' },
  });
  const maxTokensEl = tokensGroup.createEl('input', {
    cls: 'engram-params-input',
    attr: {
      id: 'engram-max-tokens',
      type: 'number',
      step: '1',
      min: '1',
      placeholder: `default (${String(defaultMaxTokens)})`,
    },
  });
  maxTokensEl.value = maxTokens;
  maxTokensEl.addEventListener('input', () => {
    const { value } = maxTokensEl;
    cb.onMaxTokensChange(value);
  });

  return { systemPromptEl, temperatureEl, maxTokensEl };
}

interface FooterRefs {
  readonly combinedModelSelect: HTMLSelectElement;
  readonly sendBtn: HTMLButtonElement;
  readonly cancelBtn: HTMLButtonElement;
}

function renderFooter(parent: HTMLElement, cb: ChatInputCallbacks): FooterRefs {
  const footer = parent.createDiv({ cls: 'engram-input-footer' });

  const combinedModelSelect = footer.createEl('select', {
    cls: 'engram-model-select',
    attr: { 'aria-label': 'Provider / model' },
  });
  combinedModelSelect.addEventListener('change', () => { cb.onModelChange(); });

  const btnGroup = footer.createDiv({ cls: 'engram-input-buttons' });

  const sendBtn = btnGroup.createEl('button', {
    cls: 'engram-send-btn',
    text: 'Send',
  });
  sendBtn.addEventListener('click', () => { cb.onSend(); });

  const cancelBtn = btnGroup.createEl('button', {
    cls: 'engram-cancel-btn',
    text: 'Cancel',
  });
  cancelBtn.style.display = 'none';
  cancelBtn.addEventListener('click', () => { cb.onCancel(); });

  return { combinedModelSelect, sendBtn, cancelBtn };
}
