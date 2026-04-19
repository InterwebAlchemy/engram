import { type App, setIcon, MarkdownRenderer } from 'obsidian';
import {
  MemoryState,
  Conversation,
} from '@interwebalchemy/engram-core';
import type { Message } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import type { ProviderAdapter } from '../providers/types';
import type { EngramTabId } from '../constants';
import type { EngramTab } from './tab';
import {
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

export class ChatTab implements EngramTab {
  readonly id: EngramTabId = 'chat';
  readonly label = CHAT_VIEW_TITLE;
  readonly icon = CHAT_VIEW_ICON;

  private readonly app: App;
  private readonly plugin: EngramPlugin;
  private parent: HTMLElement | null = null;
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
  private saveBtn!: HTMLButtonElement;
  private closeOutBtn!: HTMLButtonElement;
  private toolbarMetaEl!: HTMLElement;
  private combinedModelSelect!: HTMLSelectElement;
  private systemPromptEl!: HTMLTextAreaElement;
  private temperatureEl!: HTMLInputElement;
  private maxTokensEl!: HTMLInputElement;

  constructor(app: App, plugin: EngramPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  mount(parent: HTMLElement): void {
    parent.empty();
    parent.addClass('engram-chat-container');
    this.parent = parent;

    this.renderToolbar(parent);
    this.messagesContainer = parent.createDiv({ cls: 'engram-messages' });
    this.renderInputArea(parent);
    this.renderMessages();
  }

  unmount(): void {
    this.cancelStream();
    if (this.parent !== null) {
      this.parent.empty();
      this.parent.removeClass('engram-chat-container');
      this.parent = null;
    }
  }

  /** Re-render messages and rebuild the model selector. */
  refresh(): void {
    if (this.parent === null) {
      return;
    }
    this.renderMessages();
    this.refreshCombinedSelect();
    this.syncStreamingControls();
  }

  /** Clear cached bootstrap so the next send rebuilds from current vault state. */
  resetBootstrap(): void {
    this.bootstrapPromise = null;
  }

  // ─── Toolbar ──────────────────────────────────────────────────────────

  private renderToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: 'engram-toolbar' });
    const copy = toolbar.createDiv({ cls: 'engram-toolbar-copy' });
    const titleRow = copy.createDiv({ cls: 'engram-toolbar-title-row' });
    titleRow.createEl('h3', { text: CHAT_VIEW_TITLE });
    this.toolbarMetaEl = titleRow.createSpan({ cls: 'engram-toolbar-meta' });
    copy.createEl('p', {
      cls: 'setting-item-description',
      text: 'Keep a vault-aware working conversation here, then close out when you want to compact scratch and store durable memories.',
    });

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
    this.saveBtn = saveBtn;
    setIcon(saveBtn, 'save');
    saveBtn.addEventListener('click', () => {
      void this.plugin.saveCurrentConversation();
    });

    const closeOutBtn = actions.createEl('button', {
      cls: 'engram-toolbar-btn',
      attr: { 'aria-label': 'Save and close out (compact scratch + store memories)' },
    });
    this.closeOutBtn = closeOutBtn;
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
    this.syncStreamingControls();
  }

  private syncStreamingControls(): void {
    const {
      cancelBtn,
      closeOutBtn,
      combinedModelSelect,
      inputEl,
      isStreaming,
      saveBtn,
      sendBtn,
      toolbarMetaEl,
    } = this;
    const hasMessages = this.plugin.conversation.messages.length > 0;
    const hasSelectedModel = combinedModelSelect.value.length > 0;
    sendBtn.style.display = isStreaming ? 'none' : '';
    cancelBtn.style.display = isStreaming ? '' : 'none';
    sendBtn.disabled = isStreaming || !hasSelectedModel;
    cancelBtn.disabled = !isStreaming;
    inputEl.disabled = isStreaming;
    combinedModelSelect.disabled = isStreaming || !hasSelectedModel;
    saveBtn.disabled = isStreaming || !hasMessages;
    closeOutBtn.disabled = isStreaming || !hasMessages;
    toolbarMetaEl.setText(describeConversation(this.plugin.conversation.messages.length));
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
      combinedModelSelect.value = '';
      this.syncStreamingControls();
      return;
    }

    const valueToSelect = this.optionExists(preferredValue) ? preferredValue : firstOptionValue;
    combinedModelSelect.value = valueToSelect;
    this.syncStreamingControls();
  }

  private optionExists(value: string): boolean {
    return Array.from(this.combinedModelSelect.options).some((o) => o.value === value);
  }

  // ─── Message rendering ────────────────────────────────────────────────

  private renderMessages(): void {
    const { messagesContainer } = this;
    messagesContainer.empty();
    if (this.plugin.conversation.messages.length === 0) {
      this.renderEmptyState();
      this.syncStreamingControls();
      return;
    }
    for (const [index, message] of this.plugin.conversation.messages.entries()) {
      this.renderMessage(message, index);
    }
    const { scrollHeight } = messagesContainer;
    messagesContainer.scrollTop = scrollHeight;
    this.syncStreamingControls();
  }

  private renderEmptyState(): void {
    const panel = this.messagesContainer.createDiv({ cls: 'engram-chat-empty-state' });
    panel.createEl('h4', { text: 'Conversation is empty' });
    panel.createEl('p', {
      text: 'Choose a model below and start chatting. Message badges let you mark important turns as core, remembered, or forgotten before you save or close out.',
    });
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
    this.syncStreamingControls();
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
    this.syncStreamingControls();
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

function describeConversation(messageCount: number): string {
  if (messageCount === 0) {
    return 'Empty conversation';
  }

  return `${String(messageCount)} ${messageCount === 1 ? 'message' : 'messages'}`;
}
