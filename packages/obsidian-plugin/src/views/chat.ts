import { ItemView, type WorkspaceLeaf, setIcon, MarkdownRenderer } from 'obsidian';
import {
  MemoryState,
  Conversation,
} from '@interwebalchemy/engram-core';
import type { Message } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import type { ProviderAdapter } from '../providers/types';
import { CHAT_VIEW_TYPE } from '../constants';
import {
  CHAT_REFRESH_INTERVAL_MS,
  CHAT_VIEW_ICON,
  CHAT_VIEW_TITLE,
  getModelDisplayName,
  getReasoning,
  getRoleLabel,
  nextMemoryState,
  parseProviderModelValue,
} from './chat-view-helpers';
import {
  createCompletionRequest,
  createUserMessage,
} from './chat-view-request';
import { streamAssistantReply } from './chat-view-stream';

interface SelectedProvider {
  readonly provider: ProviderAdapter;
  readonly selectedModel: string;
}

export class EngramChatView extends ItemView {
  private readonly plugin: EngramPlugin;
  private readonly viewType = CHAT_VIEW_TYPE;
  private readonly displayText = CHAT_VIEW_TITLE;
  private readonly iconName = CHAT_VIEW_ICON;
  private abortController: AbortController | null = null;
  private isStreaming = false;

  // Per-conversation parameter overrides (empty = use global default or provider default)
  private convSystemPrompt = '';
  private convTemperature = '';
  private convMaxTokens = '';

  // DOM references
  private messagesContainer!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private cancelBtn!: HTMLButtonElement;
  private combinedModelSelect!: HTMLSelectElement;
  private systemPromptEl!: HTMLTextAreaElement;
  private temperatureEl!: HTMLInputElement;
  private maxTokensEl!: HTMLInputElement;

  constructor(leaf: WorkspaceLeaf, plugin: EngramPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return this.viewType;
  }

  getDisplayText(): string {
    return this.displayText;
  }

  getIcon(): string {
    return this.iconName;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async onOpen(): Promise<void> {
    const container = this.containerEl.children.item(1);
    if (!(container instanceof HTMLElement)) {
      throw new Error('Chat view container was not available.');
    }
    container.empty();
    container.addClass('engram-chat-container');

    this.renderToolbar(container);
    this.messagesContainer = container.createDiv({ cls: 'engram-messages' });
    this.renderInputArea(container);
    this.renderMessages();
    await Promise.resolve();
  }

  async onClose(): Promise<void> {
    this.cancelStream();
    await Promise.resolve();
  }

  /** Re-render messages and rebuild the model selector. */
  refresh(): void {
    this.renderMessages();
    this.refreshCombinedSelect();
  }

  // ─── Toolbar (action buttons only) ────────────────────────────────────

  private renderToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: 'engram-toolbar' });
    const actions = toolbar.createDiv({ cls: 'engram-toolbar-actions' });

    const newBtn = actions.createEl('button', {
      cls: 'engram-toolbar-btn',
      attr: { 'aria-label': 'New conversation' },
    });
    setIcon(newBtn, 'plus');
    newBtn.addEventListener('click', () => {
      this.plugin.conversation = new Conversation();
      this.resetConvParams();
      this.renderMessages();
    });

    const saveBtn = actions.createEl('button', {
      cls: 'engram-toolbar-btn',
      attr: { 'aria-label': 'Save conversation' },
    });
    setIcon(saveBtn, 'save');
    saveBtn.addEventListener('click', () => {
      void this.plugin.saveCurrentConversation();
    });
  }

  // ─── Input area ───────────────────────────────────────────────────────

  private renderInputArea(parent: HTMLElement): void {
    const inputContainer = parent.createDiv({ cls: 'engram-input-container' });
    const { plugin } = this;
    const { settings } = plugin;

    this.inputEl = inputContainer.createEl('textarea', {
      cls: 'engram-input',
      attr: { placeholder: 'Type a message…', rows: '3' },
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void this.handleSend();
      }
    });

    // ── Parameters panel (collapsed by default) ────────────────────────
    const paramsDetails = inputContainer.createEl('details', {
      cls: 'engram-params-details',
    });
    paramsDetails.createEl('summary', {
      cls: 'engram-params-summary',
      text: 'Parameters',
    });

    const grid = paramsDetails.createDiv({ cls: 'engram-params-grid' });

    // System prompt
    grid.createEl('label', {
      cls: 'engram-params-label',
      text: 'System prompt',
      attr: { for: 'engram-system-prompt' },
    });
    this.systemPromptEl = grid.createEl('textarea', {
      cls: 'engram-params-textarea',
      attr: {
        id: 'engram-system-prompt',
        placeholder: 'Leave empty to use the default preamble from Settings…',
        rows: '3',
      },
    });
    const {
      convSystemPrompt,
      systemPromptEl,
    } = this;
    systemPromptEl.value = convSystemPrompt;
    systemPromptEl.addEventListener('input', () => {
      const { value } = systemPromptEl;
      this.convSystemPrompt = value;
    });

    // Temperature + Max tokens side-by-side
    const numRow = grid.createDiv({ cls: 'engram-params-row' });

    const tempGroup = numRow.createDiv({ cls: 'engram-params-field' });
    tempGroup.createEl('label', {
      cls: 'engram-params-label',
      text: 'Temperature',
      attr: { for: 'engram-temperature' },
    });
    this.temperatureEl = tempGroup.createEl('input', {
      cls: 'engram-params-input',
      attr: {
        id: 'engram-temperature',
        type: 'number',
        step: '0.1',
        min: '0',
        max: '2',
        placeholder: `default (${settings.temperature})`,
      },
    });
    const {
      convTemperature,
      temperatureEl,
    } = this;
    temperatureEl.value = convTemperature;
    temperatureEl.addEventListener('input', () => {
      const { value } = temperatureEl;
      this.convTemperature = value;
    });

    const tokensGroup = numRow.createDiv({ cls: 'engram-params-field' });
    tokensGroup.createEl('label', {
      cls: 'engram-params-label',
      text: 'Max tokens',
      attr: { for: 'engram-max-tokens' },
    });
    this.maxTokensEl = tokensGroup.createEl('input', {
      cls: 'engram-params-input',
      attr: {
        id: 'engram-max-tokens',
        type: 'number',
        step: '1',
        min: '1',
        placeholder: `default (${settings.maxTokens})`,
      },
    });
    const {
      convMaxTokens,
      maxTokensEl,
    } = this;
    maxTokensEl.value = convMaxTokens;
    maxTokensEl.addEventListener('input', () => {
      const { value } = maxTokensEl;
      this.convMaxTokens = value;
    });

    // ── Footer: model selector + send/cancel ──────────────────────────
    const footer = inputContainer.createDiv({ cls: 'engram-input-footer' });

    this.combinedModelSelect = footer.createEl('select', {
      cls: 'engram-model-select',
      attr: { 'aria-label': 'Provider / model' },
    });
    this.refreshCombinedSelect();
    const { combinedModelSelect } = this;
    combinedModelSelect.addEventListener('change', () => {
      const { providerId, modelId } = parseProviderModelValue(combinedModelSelect.value);
      const { plugin: currentPlugin } = this;
      const { settings: currentSettings } = currentPlugin;
      const {
        providers,
      } = currentSettings;
      const { [providerId]: cfg } = providers;
      currentSettings.activeProviderId = providerId;
      cfg.defaultModel = modelId;
      void currentPlugin.saveSettings();
    });

    const btnGroup = footer.createDiv({ cls: 'engram-input-buttons' });

    this.sendBtn = btnGroup.createEl('button', {
      cls: 'engram-send-btn',
      text: 'Send',
    });
    this.sendBtn.addEventListener('click', () => {
      void this.handleSend();
    });

    this.cancelBtn = btnGroup.createEl('button', {
      cls: 'engram-cancel-btn',
      text: 'Cancel',
    });
    this.cancelBtn.style.display = 'none';
    this.cancelBtn.addEventListener('click', () => { this.cancelStream(); });

    this.registerInterval(
      window.setInterval(() => {
        this.sendBtn.style.display = this.isStreaming ? 'none' : '';
        this.cancelBtn.style.display = this.isStreaming ? '' : 'none';
      }, CHAT_REFRESH_INTERVAL_MS),
    );
  }

  // ─── Reset per-conversation overrides ─────────────────────────────────

  private resetConvParams(): void {
    this.convSystemPrompt = '';
    this.convTemperature = '';
    this.convMaxTokens = '';
    this.systemPromptEl.value = '';
    this.temperatureEl.value = '';
    this.maxTokensEl.value = '';
  }

  // ─── Combined provider+model select ───────────────────────────────────

  refreshCombinedSelect(): void {
    const { combinedModelSelect } = this;
    const { value: currentValue } = combinedModelSelect;
    combinedModelSelect.empty();

    const { plugin } = this;
    const { settings } = plugin;
    const {
      activeProviderId: activeId,
      providers,
    } = settings;
    const { [activeId]: activeProvider } = providers;
    const { defaultModel: activeModel } = activeProvider;
    const preferredValue = currentValue.length > 0 ? currentValue : `${activeId}::${activeModel}`;

    let hasAnyModel = false;
    let firstOptionValue = '';

    for (const [id, provider] of plugin.providers) {
      const { [id]: cfg } = providers;
      if (cfg.enabledModels.length === 0) continue;

      const group = combinedModelSelect.createEl('optgroup', {
        attr: { label: provider.name },
      });

      // Sort models alphabetically within each provider group
      const sorted = [...cfg.enabledModels].sort((a, b) => {
        const nameA = getModelDisplayName(id, a);
        const nameB = getModelDisplayName(id, b);
        return nameA.localeCompare(nameB);
      });

      for (const modelId of sorted) {
        const displayName = getModelDisplayName(id, modelId);
        const value = `${id}::${modelId}`;
        group.createEl('option', { value, text: displayName });

        if (!hasAnyModel) {
          hasAnyModel = true;
          firstOptionValue = value;
        }
      }
    }

    if (!hasAnyModel) {
      combinedModelSelect.createEl('option', {
        value: '',
        text: 'No models — configure in Settings',
      });
      combinedModelSelect.disabled = true;
      return;
    }

    combinedModelSelect.disabled = false;

    const valueToSelect = this.optionExists(preferredValue) ? preferredValue : firstOptionValue;
    combinedModelSelect.value = valueToSelect;
  }

  private optionExists(value: string): boolean {
    return Array.from(this.combinedModelSelect.options).some((o) => o.value === value);
  }

  // ─── Message rendering ────────────────────────────────────────────────

  private renderMessages(): void {
    const { messagesContainer } = this;
    messagesContainer.empty();
    for (const [index, message] of this.plugin.conversation.messages.entries()) {
      this.renderMessage(message, index);
    }
    const { scrollHeight } = messagesContainer;
    messagesContainer.scrollTop = scrollHeight;
  }

  private renderMessage(msg: Message, index: number): void {
    const bubble = this.messagesContainer.createDiv({
      cls: `engram-message engram-message-${msg.role}`,
    });

    const header = bubble.createDiv({ cls: 'engram-message-header' });
    header.createSpan({ cls: 'engram-message-role', text: getRoleLabel(msg) });

    const badge = header.createSpan({
      cls: `engram-memory-badge engram-memory-${msg.memoryState}`,
      text: msg.memoryState === MemoryState.Default ? '' : msg.memoryState,
    });
    badge.addEventListener('click', () => {
      this.cycleMemoryState(index);
    });

    const reasoning = getReasoning(msg.metadata);
    if (reasoning !== undefined) {
      const details = bubble.createEl('details', { cls: 'engram-reasoning-details' });
      details.createEl('summary', { cls: 'engram-reasoning-summary', text: 'Reasoning' });
      const reasoningContent = details.createDiv({ cls: 'engram-reasoning-content' });
      void MarkdownRenderer.render(this.app, reasoning, reasoningContent, '', this.plugin);
    }

    const content = bubble.createDiv({ cls: 'engram-message-content' });
    void MarkdownRenderer.render(this.app, msg.content, content, '', this.plugin);
  }

  private cycleMemoryState(index: number): void {
    const { plugin } = this;
    const { conversation } = plugin;
    const msg = conversation.messages.at(index);
    if (msg === undefined) {
      return;
    }
    const next = nextMemoryState(msg.memoryState);
    conversation.setMessageState(index, next);
    this.renderMessages();
  }

  // ─── Send / stream ────────────────────────────────────────────────────

  private async handleSend(): Promise<void> {
    const { inputEl, isStreaming } = this;
    const text = inputEl.value.trim();
    if (text.length === 0 || isStreaming) return;

    const selection = this.getSelectedProvider();
    if (selection === null) {
      this.appendSystemMessage('No model selected. Configure providers in Settings.');
      return;
    }
    const {
      provider,
      selectedModel,
    } = selection;

    const {
      messagesContainer,
      plugin,
    } = this;
    plugin.conversation.addMessage(createUserMessage(text));
    this.renderMessages();
    inputEl.value = '';

    const request = await createCompletionRequest({
      overrides: {
        maxTokens: this.convMaxTokens,
        systemPrompt: this.convSystemPrompt,
        temperature: this.convTemperature,
      },
      plugin,
      selectedModel,
      text,
    });
    const chatMessages = plugin.conversation.toChatMessages({
      maxMessages: request.settings.maxMemoryCount,
      systemPrompt: request.systemPrompt,
    });

    this.isStreaming = true;
    const abortController = new AbortController();
    this.abortController = abortController;

    try {
      const result = await streamAssistantReply({
        app: this.app,
        chatMessages,
        completionConfig: request.completionConfig,
        messagesContainer,
        plugin,
        provider,
        selectedModel,
        signal: abortController.signal,
      });
      if (result.status === 'ok') {
        plugin.conversation.addMessage(result.message);
      } else if (result.status === 'error') {
        this.appendSystemMessage(`Error: ${result.error}`);
      }
    } finally {
      this.isStreaming = false;
      this.abortController = null;
      this.renderMessages();
    }
  }

  private getSelectedProvider(): SelectedProvider | null {
    const {
      combinedModelSelect,
      plugin,
    } = this;
    const { providerId, modelId: selectedModel } = parseProviderModelValue(combinedModelSelect.value);
    const provider = plugin.providers.get(providerId);
    if (provider === undefined || selectedModel.length === 0) {
      return null;
    }

    const apiKey = plugin.getProviderApiKey(provider.id);
    if (apiKey !== undefined && apiKey.length > 0) {
      provider.updateConfig?.({ apiKey });
    }

    return {
      provider,
      selectedModel,
    };
  }

  private cancelStream(): void {
    this.abortController?.abort();
  }

  private appendSystemMessage(text: string): void {
    const div = this.messagesContainer.createDiv({
      cls: 'engram-message engram-message-system',
    });
    div.createSpan({ text });
  }
}
