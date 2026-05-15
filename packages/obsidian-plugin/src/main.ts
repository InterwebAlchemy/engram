import { Plugin } from 'obsidian';
import reactFlowStyles from 'reactflow/dist/style.css';
import bootstrapInstructionsTemplate from '../../../templates/engram-bootstrap.tmpl.md';
import {
  MemoryManager,
  Conversation,
  defaultMemoryConfig,
} from '@interwebalchemy/engram-core';
import { ObsidianAdapter } from './adapters/obsidian';
import { OpenAICompatibleAdapter } from './providers/openai-compat';
import { AnthropicAdapter } from './providers/anthropic';
import type { ProviderAdapter } from './providers/types';
import { getApiType } from './services/modelRegistry';
import { EngramSettingTab } from './settings';
import { EngramView } from './views/engram';
import { ChatTab } from './views/chat';
import { MemoriesTab, type MemoryMode } from './views/memory';
import {
  ENGRAM_VIEW_TYPE,
  DEFAULT_SETTINGS,
  type EngramTabId,
  type EngramSettings,
  type ProviderSettings,
} from './constants';

const REACT_FLOW_STYLE_ELEMENT_ID = 'engram-reactflow-style';
const BOOTSTRAP_INSTRUCTIONS_FILE = '.bootstrap';

export default class EngramPlugin extends Plugin {
  settings!: EngramSettings;
  memoryManager!: MemoryManager;
  conversation!: Conversation;
  fileAdapter!: ObsidianAdapter;
  providers = new Map<string, ProviderAdapter>();
  private autosaveInterval: ReturnType<typeof setInterval> | null = null;

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    injectReactFlowStyles();
    await this.loadSettings();

    const adapter = new ObsidianAdapter(this.app);
    this.fileAdapter = adapter;

    const basePath = this.getVaultBasePath();
    this.memoryManager = new MemoryManager(
      adapter,
      {
        ...defaultMemoryConfig(basePath, this.settings.vaultMode),
        engramRoot: this.settings.engramRoot,
        readPaths: this.settings.readPaths,
      },
    );
    await this.ensureBootstrapInstructionsTemplate();

    this.conversation = new Conversation();

    this.initializeProviders();

    this.registerView(ENGRAM_VIEW_TYPE, (leaf) => new EngramView(leaf, this));

    this.addSettingTab(new EngramSettingTab(this.app, this));

    this.addRibbonIcon('brain-circuit', 'Engram', async () => {
      await this.activateEngramView('chat');
    });

    this.addCommand({
      id: 'open-chat',
      name: 'Open chat',
      callback: async () => { await this.activateEngramView('chat'); },
    });

    this.addCommand({
      id: 'open-memory-manager',
      name: 'Open memory explorer',
      callback: async () => { await this.activateMemoryMode('explore'); },
    });

    this.addCommand({
      id: 'open-dreams-dashboard',
      name: 'Open memory overview',
      callback: async () => { await this.activateMemoryMode('overview'); },
    });

    this.addCommand({
      id: 'open-snapshots',
      name: 'Open snapshots',
      callback: async () => { await this.activateEngramView('snapshots'); },
    });

    this.addCommand({
      id: 'new-conversation',
      name: 'New conversation',
      callback: () => {
        this.conversation = new Conversation();
        this.resetChatBootstrap();
        this.refreshEngramView('chat');
      },
    });

    this.addCommand({
      id: 'save-conversation',
      name: 'Save conversation',
      callback: async () => { await this.saveCurrentConversation(); },
    });

    this.startAutosave();
  }

  onunload(): void {
    removeReactFlowStyles();
    this.stopAutosave();
  }

  // ─── Provider management ────────────────────────────────────────────────

  private initializeProviders(): void {
    for (const [id, cfg] of Object.entries(this.settings.providers)) {
      this.providers.set(id, instantiateProviderAdapter(cfg));
    }
  }

  reinitializeProvider(id: string): void {
    const cfg = this.getProviderSettings(id);
    if (cfg === null) {
      return;
    }

    this.providers.set(id, instantiateProviderAdapter(cfg));
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
    return instantiateProviderAdapter({
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

  async activateEngramView(tabId: EngramTabId): Promise<void> {
    const existingLeaves = this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE);
    let leaf = existingLeaves.at(0);
    if (leaf === undefined) {
      const right = this.app.workspace.getRightLeaf(false);
      if (right === null) {
        return;
      }
      await right.setViewState({ type: ENGRAM_VIEW_TYPE, active: true });
      leaf = right;
    }
    await this.app.workspace.revealLeaf(leaf);
    const { view } = leaf;
    if (view instanceof EngramView) {
      await view.activateTab(tabId);
    }
  }

  async activateMemoryMode(mode: MemoryMode): Promise<void> {
    await this.activateEngramView('memories');
    for (const leaf of this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE)) {
      const { view } = leaf;
      if (!(view instanceof EngramView)) {
        continue;
      }
      const memoryTab = view.getTab('memories');
      if (!(memoryTab instanceof MemoriesTab)) {
        continue;
      }
      switch (mode) {
        case 'overview':
          memoryTab.showOverview();
          break;
        case 'explore':
          memoryTab.showExplore();
          break;
      }
    }
  }

  // ─── Conversation persistence ──────────────────────────────────────────

  async saveCurrentConversation(): Promise<void> {
    if (this.conversation.messages.length === 0) return;
    await this.memoryManager.saveConversation(this.conversation);
  }

  /** Refresh a specific tab inside every open Engram view. */
  refreshEngramView(tabId: EngramTabId): void {
    for (const leaf of this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE)) {
      const { view } = leaf;
      if (view instanceof EngramView) {
        void view.refreshTab(tabId);
      }
    }
  }

  /** Clear chat tab bootstrap cache across open views. */
  resetChatBootstrap(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(ENGRAM_VIEW_TYPE)) {
      const { view } = leaf;
      if (!(view instanceof EngramView)) continue;
      const chat = view.getTab('chat');
      if (chat instanceof ChatTab) {
        chat.resetBootstrap();
      }
    }
  }

  getVaultBasePath(): string {
    return getStringProperty(this.app.vault.adapter, 'basePath') ?? '';
  }

  getBootstrapInstructionsPath(): string {
    const root = this.settings.engramRoot.replace(/\/+$/u, '');
    return root.length > 0
      ? `${root}/${BOOTSTRAP_INSTRUCTIONS_FILE}`
      : BOOTSTRAP_INSTRUCTIONS_FILE;
  }

  async readBootstrapInstructionsTemplate(): Promise<string | null> {
    const target = this.getBootstrapInstructionsPath();
    try {
      if (!(await this.fileAdapter.exists(target))) {
        return null;
      }
      return normalizeBootstrapTemplate(await this.fileAdapter.read(target));
    } catch {
      return null;
    }
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

  private async ensureBootstrapInstructionsTemplate(): Promise<void> {
    const target = this.getBootstrapInstructionsPath();
    const template = normalizeBootstrapTemplate(bootstrapInstructionsTemplate);
    try {
      const current = await this.fileAdapter.exists(target)
        ? normalizeBootstrapTemplate(await this.fileAdapter.read(target))
        : null;
      if (current === template) {
        return;
      }
      await this.fileAdapter.write(target, template);
    } catch {
      // Bootstrap visualization should never block plugin startup.
    }
  }

  private getProviderSettings(providerId: string): ProviderSettings | null {
    if (!Object.hasOwn(this.settings.providers, providerId)) {
      return null;
    }

    return this.settings.providers[providerId];
  }

  // ─── Settings ──────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const loaded: unknown = await this.loadData();
    const loadedSettings = isSettingsRecord(loaded) ? loaded : {};
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loadedSettings,
      dreams: {
        ...DEFAULT_SETTINGS.dreams,
        ...(loadedSettings.dreams ?? {}),
      },
      providers: { ...DEFAULT_SETTINGS.providers },
    };
    for (const [id, defaults] of Object.entries(DEFAULT_SETTINGS.providers)) {
      this.settings.providers[id] = {
        ...defaults,
        ...(loadedSettings.providers?.[id] ?? {}),
      };
    }
    for (const [id, provider] of Object.entries(loadedSettings.providers ?? {})) {
      if (Object.hasOwn(this.settings.providers, id)) {
        continue;
      }
      this.settings.providers[id] = provider;
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

function injectReactFlowStyles(): void {
  if (document.getElementById(REACT_FLOW_STYLE_ELEMENT_ID) !== null) {
    return;
  }
  const styleEl = document.createElement('style');
  styleEl.id = REACT_FLOW_STYLE_ELEMENT_ID;
  styleEl.textContent = reactFlowStyles;
  document.head.appendChild(styleEl);
}

function removeReactFlowStyles(): void {
  document.getElementById(REACT_FLOW_STYLE_ELEMENT_ID)?.remove();
}

function normalizeBootstrapTemplate(content: string): string {
  return `${content.trimEnd()}\n`;
}

function isSettingsRecord(value: unknown): value is Partial<EngramSettings> {
  return typeof value === 'object' && value !== null;
}

function instantiateProviderAdapter(
  cfg: ProviderSettings & { apiKey?: string },
): ProviderAdapter {
  if (getApiType(cfg.id) === 'anthropic') {
    return new AnthropicAdapter(cfg);
  }

  return new OpenAICompatibleAdapter(cfg);
}
