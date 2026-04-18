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
import { buildEngramBootstrap } from './chat-view-bootstrap';
import { renderChatInputArea } from './chat-view-input';
import {
  createCompletionRequest,
  createUserMessage,
} from './chat-view-request';
import { streamAssistantReply } from './chat-view-stream';

const CLOSE_OUT_INSTRUCTION = [
  'Close-out: use your Engram tools to wrap up this session.',
  '1. scratch(action: "compact") — collapse your scratch entries from this session into a one-line summary of what we accomplished.',
  '2. memory(action: "store") — capture any durable insights, decisions, or patterns worth keeping for future Fragments.',
  'Skip either step if there is nothing worth recording. Be concise.',
].join('\n');

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

  // Engram bootstrap (Soul + thread + inbox + scratch), built once per conversation.
  private bootstrapPromise: Promise<string> | null = null;

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

  /** Clear cached bootstrap so the next send rebuilds from current vault state. */
  resetBootstrap(): void {
    this.bootstrapPromise = null;
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
      this.resetBootstrap();
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

    const closeOutBtn = actions.createEl('button', {
      cls: 'engram-toolbar-btn',
      attr: { 'aria-label': 'Save and close out (compact scratch + store memories)' },
    });
    setIcon(closeOutBtn, 'archive');
    closeOutBtn.addEventListener('click', () => {
      void this.handleCloseOut();
    });
  }

  // ─── Input area ───────────────────────────────────────────────────────

  private renderInputArea(parent: HTMLElement): void {
    const { plugin } = this;
    const { settings } = plugin;
    const refs = renderChatInputArea(parent, {
      initialOverrides: {
        systemPrompt: this.convSystemPrompt,
        temperature: this.convTemperature,
        maxTokens: this.convMaxTokens,
      },
      defaultTemperature: settings.temperature,
      defaultMaxTokens: settings.maxTokens,
      onSystemPromptChange: (v) => { this.convSystemPrompt = v; },
      onTemperatureChange: (v) => { this.convTemperature = v; },
      onMaxTokensChange: (v) => { this.convMaxTokens = v; },
      onSend: () => { void this.handleSend(); },
      onCancel: () => { this.cancelStream(); },
      onEnterSubmit: () => { void this.handleSend(); },
      onModelChange: () => { this.handleModelChange(); },
    });

    const {
      inputEl,
      systemPromptEl,
      temperatureEl,
      maxTokensEl,
      combinedModelSelect,
      sendBtn,
      cancelBtn,
    } = refs;
    this.inputEl = inputEl;
    this.systemPromptEl = systemPromptEl;
    this.temperatureEl = temperatureEl;
    this.maxTokensEl = maxTokensEl;
    this.combinedModelSelect = combinedModelSelect;
    this.sendBtn = sendBtn;
    this.cancelBtn = cancelBtn;

    this.refreshCombinedSelect();
    this.registerInterval(
      window.setInterval(() => {
        this.sendBtn.style.display = this.isStreaming ? 'none' : '';
        this.cancelBtn.style.display = this.isStreaming ? '' : 'none';
      }, CHAT_REFRESH_INTERVAL_MS),
    );
  }

  private handleModelChange(): void {
    const { combinedModelSelect, plugin } = this;
    const { providerId, modelId } = parseProviderModelValue(combinedModelSelect.value);
    const { settings } = plugin;
    settings.activeProviderId = providerId;
    settings.providers[providerId].defaultModel = modelId;
    void plugin.saveSettings();
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
    const { inputEl } = this;
    const text = inputEl.value.trim();
    if (text.length === 0) return;
    inputEl.value = '';
    await this.sendUserText(text);
  }

  private async handleCloseOut(): Promise<void> {
    if (this.isStreaming) return;
    const { plugin } = this;
    if (plugin.conversation.messages.length === 0) {
      this.appendSystemMessage('Nothing to close out — conversation is empty.');
      return;
    }
    if (!plugin.settings.toolCallingEnabled) {
      this.appendSystemMessage(
        'Close-out needs tool calling. Enable "Tool calling" in Settings and try again.',
      );
      return;
    }
    await plugin.saveCurrentConversation();
    await this.sendUserText(CLOSE_OUT_INSTRUCTION);
  }

  private async sendUserText(text: string): Promise<void> {
    if (this.isStreaming) return;
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

    const bootstrap = await this.ensureBootstrap();
    const request = await createCompletionRequest({
      bootstrap,
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

  private async ensureBootstrap(): Promise<string> {
    this.bootstrapPromise ??= buildEngramBootstrap(this.plugin)
      .then((result) => result.content)
      .catch(() => '');
    return await this.bootstrapPromise;
  }

  private appendSystemMessage(text: string): void {
    const div = this.messagesContainer.createDiv({
      cls: 'engram-message engram-message-system',
    });
    div.createSpan({ text });
  }
}
