import { Plugin } from 'obsidian';
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
import { EngramDreamsView } from './views/dreams';
import { EngramMemoryView } from './views/memory';
import {
  CHAT_VIEW_TYPE,
  DREAMS_VIEW_TYPE,
  MEMORY_VIEW_TYPE,
  DEFAULT_SETTINGS,
} from './constants';
import type {
  EngramSettings,
  ProviderSettings,
} from './constants';

export default class EngramPlugin extends Plugin {
  settings!: EngramSettings;
  memoryManager!: MemoryManager;
  conversation!: Conversation;
  fileAdapter!: ObsidianAdapter;
  providers = new Map<string, ProviderAdapter>();
  private autosaveInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    await this.loadSettings();

    // Filesystem adapter backed by the Obsidian vault API
    const adapter = new ObsidianAdapter(this.app);
    this.fileAdapter = adapter;

    // Memory manager scoped to the engram root
    const basePath = this.getVaultBasePath();
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
    this.registerView(DREAMS_VIEW_TYPE, (leaf) => new EngramDreamsView(leaf, this));

    // Settings tab
    this.addSettingTab(new EngramSettingTab(this.app, this));

    // Ribbon icon to open the chat
    this.addRibbonIcon('brain', 'Open Engram chat', async () => { await this.activateChatView(); });

    // Command palette entries
    this.addCommand({
      id: 'open-chat',
      name: 'Open chat',
      callback: async () => { await this.activateChatView(); },
    });

    this.addCommand({
      id: 'open-memory-manager',
      name: 'Open memory manager',
      callback: async () => { await this.activateMemoryView(); },
    });

    this.addCommand({
      id: 'open-dreams-dashboard',
      name: 'Open Dreams dashboard',
      callback: async () => { await this.activateDreamsView(); },
    });

    this.addCommand({
      id: 'new-conversation',
      name: 'New conversation',
      callback: () => {
        this.conversation = new Conversation();
        this.resetChatViewBootstrap();
        this.refreshChatView();
      },
    });

    this.addCommand({
      id: 'save-conversation',
      name: 'Save conversation',
      callback: async () => { await this.saveCurrentConversation(); },
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
    const cfg = this.getProviderSettings(id);
    if (cfg === null) {
      return;
    }

    if (id === 'anthropic') {
      this.providers.set(id, new AnthropicAdapter(cfg));
    } else {
      this.providers.set(id, new OpenAICompatibleAdapter(cfg));
    }
  }

  getActiveProvider(): ProviderAdapter | undefined {
    return this.providers.get(this.settings.activeProviderId);
  }

  createProviderAdapter(providerId: string): ProviderAdapter | undefined {
    const cfg = this.getProviderSettings(providerId);
    if (cfg === null) {
      return undefined;
    }

    const apiKey = this.getProviderApiKey(providerId);
    if (providerId === 'anthropic') {
      return new AnthropicAdapter({
        ...cfg,
        apiKey,
      });
    }

    return new OpenAICompatibleAdapter({
      ...cfg,
      apiKey,
    });
  }

  getProviderApiKey(providerId: string): string | undefined {
    const cfg = this.getProviderSettings(providerId);
    if (cfg === null) {
      return undefined;
    }

    const { apiKeySecret: secretId } = cfg;
    if (secretId === undefined || secretId.length === 0) {
      return undefined;
    }

    try {
      return this.app.secretStorage.getSecret(secretId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  // ─── View activation ───────────────────────────────────────────────────

  async activateChatView(): Promise<void> {
    await this.activateView(CHAT_VIEW_TYPE);
  }

  async activateMemoryView(): Promise<void> {
    await this.activateView(MEMORY_VIEW_TYPE);
  }

  async activateDreamsView(): Promise<void> {
    await this.activateView(DREAMS_VIEW_TYPE);
  }

  // ─── Conversation persistence ──────────────────────────────────────────

  async saveCurrentConversation(): Promise<void> {
    if (this.conversation.messages.length === 0) return;
    await this.memoryManager.saveConversation(this.conversation);
  }

  refreshChatView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      const { view } = leaf;
      if (view instanceof EngramChatView) {
        view.refresh();
      }
    }
  }

  resetChatViewBootstrap(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE)) {
      const { view } = leaf;
      if (view instanceof EngramChatView) {
        view.resetBootstrap();
      }
    }
  }

  refreshDreamsView(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(DREAMS_VIEW_TYPE)) {
      const { view } = leaf;
      if (view instanceof EngramDreamsView) {
        void view.refresh();
      }
    }
  }

  getVaultBasePath(): string {
    return getStringProperty(this.app.vault.adapter, 'basePath') ?? '';
  }

  // ─── Autosave ──────────────────────────────────────────────────────────

  private startAutosave(): void {
    this.stopAutosave();
    if (this.settings.autosaveEnabled) {
      this.autosaveInterval = setInterval(
        () => {
          void this.saveCurrentConversation();
        },
        this.settings.autosaveIntervalMs,
      );
    }
  }

  private stopAutosave(): void {
    if (this.autosaveInterval !== null) {
      clearInterval(this.autosaveInterval);
      this.autosaveInterval = null;
    }
  }

  private getProviderSettings(providerId: string): ProviderSettings | null {
    if (!Object.hasOwn(this.settings.providers, providerId)) {
      return null;
    }

    return this.settings.providers[providerId];
  }

  private async activateView(viewType: string): Promise<void> {
    const existingLeaves = this.app.workspace.getLeavesOfType(viewType);
    if (existingLeaves.length > 0) {
      await this.app.workspace.revealLeaf(existingLeaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf === null) {
      return;
    }

    await leaf.setViewState({ type: viewType, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  // ─── Settings ──────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const loaded: unknown = await this.loadData();
    const loadedSettings = isSettingsRecord(loaded) ? loaded : {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loadedSettings,
      providers: { ...DEFAULT_SETTINGS.providers },
    };
    // Deep-merge provider configs so new fields (enabledModels, customModels, etc.)
    // are present even when loading an older saved config.
    for (const [id, defaults] of Object.entries(DEFAULT_SETTINGS.providers)) {
      this.settings.providers[id] = {
        ...defaults,
        ...(loadedSettings.providers?.[id] ?? {}),
      };
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

function getStringProperty(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }

  for (const [propertyKey, propertyValue] of Object.entries(value)) {
    if (propertyKey === key && typeof propertyValue === 'string') {
      return propertyValue;
    }
  }

  return undefined;
}

function isSettingsRecord(value: unknown): value is Partial<EngramSettings> {
  return typeof value === 'object' && value !== null;
}
