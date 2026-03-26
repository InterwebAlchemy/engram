import { ItemView, WorkspaceLeaf, setIcon, MarkdownRenderer } from 'obsidian';
import {
  MemoryState,
  Conversation,
  pruneMessages,
} from '@interwebalchemy/engram-core';
import type { Message, ChatMessage } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import type { StreamChunk, CompletionConfig } from '../providers/types';
import { Ciph3rTextAnimator } from '../utils/ciph3r';
import { CHAT_VIEW_TYPE, KNOWN_MODELS } from '../constants';

/** Extract content from inline `<think>` or `<thinking>` blocks in model output. */
function parseThinkContent(raw: string): { content: string; reasoning: string } {
  const openRe = /^[\s\S]*?<think(?:ing)?>[ \t]*/i;
  const openMatch = raw.match(openRe);
  if (!openMatch) return { content: raw, reasoning: '' };

  const afterOpen = raw.slice(openMatch[0].length);
  const closeMatch = afterOpen.match(/^([\s\S]*?)<\/think(?:ing)?>[ \t]*/i);
  if (!closeMatch) {
    // Tag not yet closed — treat everything after open tag as reasoning, no content yet
    return { content: '', reasoning: afterOpen };
  }

  return {
    content: afterOpen.slice(closeMatch[0].length).trimStart(),
    reasoning: closeMatch[1].trim(),
  };
}

export class EngramChatView extends ItemView {
  private plugin: EngramPlugin;
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
    return CHAT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Engram Chat';
  }

  getIcon(): string {
    return 'brain';
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('engram-chat-container');

    this.renderToolbar(container);
    this.messagesContainer = container.createDiv({ cls: 'engram-messages' });
    this.renderInputArea(container);
    this.renderMessages();
  }

  async onClose(): Promise<void> {
    this.cancelStream();
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
    saveBtn.addEventListener('click', () => this.plugin.saveCurrentConversation());
  }

  // ─── Input area ───────────────────────────────────────────────────────

  private renderInputArea(parent: HTMLElement): void {
    const inputContainer = parent.createDiv({ cls: 'engram-input-container' });

    this.inputEl = inputContainer.createEl('textarea', {
      cls: 'engram-input',
      attr: { placeholder: 'Type a message…', rows: '3' },
    });
    this.inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.handleSend();
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
    this.systemPromptEl.value = this.convSystemPrompt;
    this.systemPromptEl.addEventListener('input', () => {
      this.convSystemPrompt = this.systemPromptEl.value;
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
        placeholder: `default (${this.plugin.settings.temperature})`,
      },
    });
    this.temperatureEl.value = this.convTemperature;
    this.temperatureEl.addEventListener('input', () => {
      this.convTemperature = this.temperatureEl.value;
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
        placeholder: `default (${this.plugin.settings.maxTokens})`,
      },
    });
    this.maxTokensEl.value = this.convMaxTokens;
    this.maxTokensEl.addEventListener('input', () => {
      this.convMaxTokens = this.maxTokensEl.value;
    });

    // ── Footer: model selector + send/cancel ──────────────────────────
    const footer = inputContainer.createDiv({ cls: 'engram-input-footer' });

    this.combinedModelSelect = footer.createEl('select', {
      cls: 'engram-model-select',
      attr: { 'aria-label': 'Provider / model' },
    });
    this.refreshCombinedSelect();
    this.combinedModelSelect.addEventListener('change', () => {
      const [providerId, modelId] = this.combinedModelSelect.value.split('::');
      const cfg = this.plugin.settings.providers[providerId];
      if (cfg) {
        this.plugin.settings.activeProviderId = providerId;
        cfg.defaultModel = modelId;
        this.plugin.saveSettings();
      }
    });

    const btnGroup = footer.createDiv({ cls: 'engram-input-buttons' });

    this.sendBtn = btnGroup.createEl('button', {
      cls: 'engram-send-btn',
      text: 'Send',
    });
    this.sendBtn.addEventListener('click', () => this.handleSend());

    this.cancelBtn = btnGroup.createEl('button', {
      cls: 'engram-cancel-btn',
      text: 'Cancel',
    });
    this.cancelBtn.style.display = 'none';
    this.cancelBtn.addEventListener('click', () => this.cancelStream());

    this.registerInterval(
      window.setInterval(() => {
        this.sendBtn.style.display = this.isStreaming ? 'none' : '';
        this.cancelBtn.style.display = this.isStreaming ? '' : 'none';
      }, 100),
    );
  }

  // ─── Reset per-conversation overrides ─────────────────────────────────

  private resetConvParams(): void {
    this.convSystemPrompt = '';
    this.convTemperature = '';
    this.convMaxTokens = '';
    if (this.systemPromptEl) this.systemPromptEl.value = '';
    if (this.temperatureEl) this.temperatureEl.value = '';
    if (this.maxTokensEl) this.maxTokensEl.value = '';
  }

  // ─── Combined provider+model select ───────────────────────────────────

  refreshCombinedSelect(): void {
    if (!this.combinedModelSelect) return;

    const currentValue = this.combinedModelSelect.value;
    this.combinedModelSelect.empty();

    const activeId = this.plugin.settings.activeProviderId;
    const activeModel = this.plugin.settings.providers[activeId]?.defaultModel ?? '';
    const preferredValue = currentValue || `${activeId}::${activeModel}`;

    let hasAnyModel = false;
    let firstOptionValue = '';

    for (const [id, provider] of this.plugin.providers) {
      const cfg = this.plugin.settings.providers[id];
      if (!cfg || cfg.enabledModels.length === 0) continue;

      const group = this.combinedModelSelect.createEl('optgroup', {
        attr: { label: provider.name },
      });

      // Sort models alphabetically within each provider group
      const sorted = [...cfg.enabledModels].sort((a, b) => {
        const nameA = KNOWN_MODELS[id]?.find((m) => m.id === a)?.name ?? a;
        const nameB = KNOWN_MODELS[id]?.find((m) => m.id === b)?.name ?? b;
        return nameA.localeCompare(nameB);
      });

      for (const modelId of sorted) {
        const knownName = KNOWN_MODELS[id]?.find((m) => m.id === modelId)?.name;
        const displayName = knownName ?? modelId;
        const value = `${id}::${modelId}`;
        group.createEl('option', { value, text: displayName });

        if (!hasAnyModel) {
          hasAnyModel = true;
          firstOptionValue = value;
        }
      }
    }

    if (!hasAnyModel) {
      this.combinedModelSelect.createEl('option', {
        value: '',
        text: 'No models — configure in Settings',
      });
      this.combinedModelSelect.disabled = true;
      return;
    }

    this.combinedModelSelect.disabled = false;

    const valueToSelect = this.optionExists(preferredValue) ? preferredValue : firstOptionValue;
    this.combinedModelSelect.value = valueToSelect;
  }

  private optionExists(value: string): boolean {
    return Array.from(this.combinedModelSelect.options).some((o) => o.value === value);
  }

  // ─── Message rendering ────────────────────────────────────────────────

  private renderMessages(): void {
    this.messagesContainer.empty();
    for (let i = 0; i < this.plugin.conversation.messages.length; i++) {
      this.renderMessage(this.plugin.conversation.messages[i], i);
    }
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  private renderMessage(msg: Message, index: number): void {
    const bubble = this.messagesContainer.createDiv({
      cls: `engram-message engram-message-${msg.role}`,
    });

    const header = bubble.createDiv({ cls: 'engram-message-header' });
    const roleLabel =
      msg.role === 'assistant'
        ? `Assistant${msg.model ? ` [${msg.model}]` : ''}`
        : msg.role === 'system'
          ? 'System'
          : 'You';
    header.createSpan({ cls: 'engram-message-role', text: roleLabel });

    const badge = header.createSpan({
      cls: `engram-memory-badge engram-memory-${msg.memoryState}`,
      text: msg.memoryState !== MemoryState.Default ? msg.memoryState : '',
    });
    badge.addEventListener('click', () => this.cycleMemoryState(index));

    const reasoning = msg.metadata?.reasoning as string | undefined;
    if (reasoning) {
      const details = bubble.createEl('details', { cls: 'engram-reasoning-details' });
      details.createEl('summary', { cls: 'engram-reasoning-summary', text: 'Reasoning' });
      const reasoningContent = details.createDiv({ cls: 'engram-reasoning-content' });
      MarkdownRenderer.render(this.app, reasoning, reasoningContent, '', this.plugin);
    }

    const content = bubble.createDiv({ cls: 'engram-message-content' });
    MarkdownRenderer.render(this.app, msg.content, content, '', this.plugin);
  }

  private cycleMemoryState(index: number): void {
    const msg = this.plugin.conversation.messages[index];
    const states = [
      MemoryState.Default,
      MemoryState.Core,
      MemoryState.Remembered,
      MemoryState.Forgotten,
    ];
    const next = states[(states.indexOf(msg.memoryState) + 1) % states.length];
    this.plugin.conversation.setMessageState(index, next);
    this.renderMessages();
  }

  // ─── Send / stream ────────────────────────────────────────────────────

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text || this.isStreaming) return;

    const [selectedProviderId, selectedModel] = this.combinedModelSelect.value.split('::');
    const provider = this.plugin.providers.get(selectedProviderId);

    if (!provider || !selectedModel) {
      this.appendSystemMessage('No model selected. Configure providers in Settings.');
      return;
    }

    const apiKey = await this.plugin.getProviderApiKey(provider.id);
    if (apiKey) {
      (provider as { updateConfig?: (c: { apiKey: string }) => void }).updateConfig?.({ apiKey });
    }

    const userMsg: Message = {
      role: 'user',
      content: text,
      timestamp: new Date(),
      memoryState: MemoryState.Default,
    };
    this.plugin.conversation.addMessage(userMsg);
    this.renderMessages();
    this.inputEl.value = '';

    const settings = this.plugin.settings;

    // Per-conversation overrides: empty → fall back to global setting → undefined (provider default)
    const temperature = this.convTemperature !== ''
      ? parseFloat(this.convTemperature)
      : settings.temperature ?? undefined;

    const maxTokens = this.convMaxTokens !== ''
      ? parseInt(this.convMaxTokens, 10)
      : settings.maxTokens ?? undefined;

    const basePrompt = this.convSystemPrompt.trim() || settings.defaultPreamble || '';

    // ── Load vault memory context ─────────────────────────────────────────
    let memoryBlock = '';
    try {
      const sections = await this.plugin.memoryManager.getContext(
        text,
        { max: (maxTokens ?? 8192) * 3 },
      );
      if (sections.length > 0) {
        sections.sort((a, b) => b.priority - a.priority);
        memoryBlock = sections
          .map((s) => {
            // Humanise the label: 'soul-document' → 'Soul', 'memory:.../facts/user-name.md' → 'user-name'
            const label = s.label === 'soul-document'
              ? 'Soul'
              : s.label.replace(/^memory:.*[\\/]/, '').replace(/\.md$/, '');
            return `### ${label}\n\n${s.content.trim()}`;
          })
          .join('\n\n---\n\n');
      }
    } catch {
      // Memory context is best-effort — never block the completion
    }

    const systemPrompt = memoryBlock
      ? (basePrompt ? `${basePrompt}\n\n## Memories\n\n${memoryBlock}` : `## Memories\n\n${memoryBlock}`)
      : (basePrompt || undefined);

    const chatMessages = this.plugin.conversation.toChatMessages({
      maxMessages: settings.maxMemoryCount,
      systemPrompt,
    });

    const completionConfig: CompletionConfig = {
      model: selectedModel,
      temperature,
      maxTokens,
    };

    this.isStreaming = true;
    this.abortController = new AbortController();

    let accumulated = '';
    let accumulatedReasoning = '';
    let contentStarted = false;

    const streamingBubble = this.messagesContainer.createDiv({
      cls: 'engram-message engram-message-assistant engram-message-streaming',
    });
    streamingBubble.createDiv({ cls: 'engram-message-header' }).createSpan({
      cls: 'engram-message-role',
      text: `Assistant [${selectedModel}]`,
    });

    // Thinking indicator — shown while waiting/reasoning, may become the persisted reasoning block
    const thinkingDetails = streamingBubble.createEl('details', {
      cls: 'engram-reasoning-details engram-reasoning-streaming',
      attr: { open: '' },
    });
    const thinkingSummary = thinkingDetails.createEl('summary', { cls: 'engram-reasoning-summary' });
    const thinkingLabel = thinkingSummary.createSpan({ text: 'Thinking...' });
    const thinkingBody = thinkingDetails.createDiv({ cls: 'engram-reasoning-content' });

    const animator = new Ciph3rTextAnimator(thinkingLabel, 'Thinking...');
    animator.start();

    const streamingContent = streamingBubble.createDiv({ cls: 'engram-message-content' });

    try {
      for await (const chunk of provider.stream(
        chatMessages,
        completionConfig,
        this.abortController.signal,
      )) {
        if (chunk.done) break;

        if (chunk.reasoning) {
          accumulatedReasoning += chunk.reasoning;
          thinkingBody.empty();
          MarkdownRenderer.render(this.app, accumulatedReasoning, thinkingBody, '', this.plugin);
          this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }

        if (chunk.content) {
          accumulated += chunk.content;
          if (!contentStarted) {
            contentStarted = true;
            animator.stop();
            thinkingDetails.removeAttribute('open');
            thinkingDetails.classList.remove('engram-reasoning-streaming');
          }
          streamingContent.empty();
          MarkdownRenderer.render(this.app, accumulated, streamingContent, '', this.plugin);
          this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        }
      }

      animator.stop();
      thinkingDetails.classList.remove('engram-reasoning-streaming');

      // Fall back to parsing inline <think>/<thinking> tags if no structured reasoning
      let finalContent = accumulated;
      let finalReasoning = accumulatedReasoning;
      if (!finalReasoning) {
        const parsed = parseThinkContent(accumulated);
        finalContent = parsed.content || accumulated;
        finalReasoning = parsed.reasoning;
        if (finalReasoning) {
          thinkingBody.empty();
          MarkdownRenderer.render(this.app, finalReasoning, thinkingBody, '', this.plugin);
        }
      }

      if (!finalReasoning) {
        thinkingDetails.remove();
      }

      const assistantMsg: Message = {
        role: 'assistant',
        content: finalContent,
        timestamp: new Date(),
        provider: provider.id,
        model: selectedModel,
        memoryState: MemoryState.Default,
        metadata: finalReasoning ? { reasoning: finalReasoning } : undefined,
      };
      this.plugin.conversation.addMessage(assistantMsg);
    } catch (err) {
      animator.stop();
      if ((err as Error).name !== 'AbortError') {
        this.appendSystemMessage(`Error: ${(err as Error).message}`);
      }
    } finally {
      this.isStreaming = false;
      this.abortController = null;
      this.renderMessages();
    }
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
