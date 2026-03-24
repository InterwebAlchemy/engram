import { Plugin, WorkspaceLeaf } from 'obsidian';
import {
  MemoryManager,
  Conversation,
  defaultMemoryConfig,
} from '@interwebalchemy/engram-core';
import { ObsidianAdapter } from './adapters/obsidian';
import { OpenAICompatibleAdapter } from './providers/openai-compat';
import { AnthropicAdapter } from './providers/anthropic';
import type { ProviderAdapter } from './providers/types';
import { EngramSettingTab } from './settings';
import { EngramChatView } from './views/chat';
import { EngramMemoryView } from './views/memory';
import {
  CHAT_VIEW_TYPE,
  MEMORY_VIEW_TYPE,
  DEFAULT_SETTINGS,
} from './constants';
import type { EngramSettings } from './constants';

export default class EngramPlugin extends Plugin {
  settings!: EngramSettings;
  memoryManager!: MemoryManager;
  conversation!: Conversation;
  providers: Map<string, ProviderAdapter> = new Map();
  private autosaveInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Filesystem adapter backed by the Obsidian vault API
    const adapter = new ObsidianAdapter(this.app);

    // Memory manager scoped to the engram root
    const basePath = (this.app.vault.adapter as unknown as { basePath?: string }).basePath ?? '';
    this.memoryManager = new MemoryManager(
      adapter,
      {
        ...defaultMemoryConfig(basePath, this.settings.vaultMode),
        engramRoot: this.settings.engramRoot,
        readPaths: this.settings.readPaths,
      },
    );

    this.conversation = new Conversation();

    // Initialize provider adapters
    this.initializeProviders();

    // Register views
    this.registerView(CHAT_VIEW_TYPE, (leaf) => new EngramChatView(leaf, this));
    this.registerView(MEMORY_VIEW_TYPE, (leaf) => new EngramMemoryView(leaf, this));

    // Settings tab
    this.addSettingTab(new EngramSettingTab(this.app, this));

    // Ribbon icon to open the chat
    this.addRibbonIcon('brain', 'Open Engram chat', () => this.activateChatView());

    // Command palette entries
    this.addCommand({
      id: 'open-chat',
      name: 'Open chat',
      callback: () => this.activateChatView(),
    });

    this.addCommand({
      id: 'open-memory-manager',
      name: 'Open memory manager',
      callback: () => this.activateMemoryView(),
    });

    this.addCommand({
      id: 'new-conversation',
      name: 'New conversation',
      callback: () => {
        this.conversation = new Conversation();
        this.refreshChatView();
      },
    });

    this.addCommand({
      id: 'save-conversation',
      name: 'Save conversation',
      callback: () => this.saveCurrentConversation(),
    });

    // Autosave
    this.startAutosave();
  }

  onunload(): void {
    this.stopAutosave();
  }

  // ─── Provider management ────────────────────────────────────────────────

  private initializeProviders(): void {
    for (const [id, cfg] of Object.entries(this.settings.providers)) {
      if (id === 'anthropic') {
        this.providers.set(id, new AnthropicAdapter(cfg));
      } else {
        this.providers.set(id, new OpenAICompatibleAdapter(cfg));
      }
    }
  }

  /** Re-initialize a single provider after its config changes (e.g. base URL update). */
  reinitializeProvider(id: string): void {
    const cfg = this.settings.providers[id];
    if (!cfg) return;
    if (id === 'anthropic') {
      this.providers.set(id, new AnthropicAdapter(cfg));
    } else {
      this.providers.set(id, new OpenAICompatibleAdapter(cfg));
    }
  }

  getActiveProvider(): ProviderAdapter | undefined {
    return this.providers.get(this.settings.activeProviderId);
  }

  async getProviderApiKey(providerId: string): Promise<string | undefined> {
    return this.getSecret(`${providerId}-api-key`);
  }

  // ─── Secret storage ─────────────────────────────────────────────────────

  async getSecret(key: string): Promise<string | undefined> {
    try {
      // SecretStorage available in Obsidian 1.11.4+
      const storage = (this.app as unknown as { loadLocalStorage?: (key: string) => string | null }).loadLocalStorage;
      if (storage) return storage(key) ?? undefined;
    } catch {
      // Fallback: not available on this platform
    }
    return undefined;
  }

  async setSecret(key: string, value: string): Promise<void> {
    try {
      const storage = (this.app as unknown as { saveLocalStorage?: (key: string, value: string) => void }).saveLocalStorage;
      if (storage) storage(key, value);
    } catch {
      // SecretStorage not available
    }
  }

  // ─── View activation ───────────────────────────────────────────────────

  async activateChatView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  async activateMemoryView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(MEMORY_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: MEMORY_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  // ─── Conversation persistence ──────────────────────────────────────────

  async saveCurrentConversation(): Promise<void> {
    if (this.conversation.messages.length === 0) return;
    await this.memoryManager.saveConversation(this.conversation);
  }

  refreshChatView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof EngramChatView) {
        view.refresh();
      }
    }
  }

  // ─── Autosave ──────────────────────────────────────────────────────────

  private startAutosave(): void {
    this.stopAutosave();
    if (this.settings.autosaveEnabled) {
      this.autosaveInterval = setInterval(
        () => this.saveCurrentConversation(),
        this.settings.autosaveIntervalMs,
      );
    }
  }

  private stopAutosave(): void {
    if (this.autosaveInterval) {
      clearInterval(this.autosaveInterval);
      this.autosaveInterval = null;
    }
  }

  // ─── Settings ──────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const loaded = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
    // Deep-merge provider configs so new fields (enabledModels, customModels, etc.)
    // are present even when loading an older saved config.
    for (const [id, defaults] of Object.entries(DEFAULT_SETTINGS.providers)) {
      this.settings.providers[id] = Object.assign({}, defaults, this.settings.providers[id]);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
