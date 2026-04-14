import { type App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type EngramPlugin from './main';
import { DEFAULT_SETTINGS, KNOWN_MODELS, BUILTIN_PROVIDER_IDS } from './constants';
import type { ProviderSettings } from './constants';

const MAX_MEMORY_COUNT = 50;
const TEMPERATURE_MAX = 2;
const TEMPERATURE_STEP = 0.1;
const CONTEXT_WINDOW_DIVISOR = 1000;
const DEFAULT_CUSTOM_PROVIDER_URL = 'http://localhost:11434';

export class EngramSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: EngramPlugin) {
    super(app, plugin);
  }

  display(): void {
    const {
      containerEl,
      plugin,
    } = this;
    const { settings } = plugin;
    const { providers } = settings;
    containerEl.empty();

    // ─── Active Provider ──────────────────────────────────────────────────

    containerEl.createEl('h2', { text: 'Providers' });

    const allProviderIds = Object.keys(providers);
    const builtinIds: readonly string[] = BUILTIN_PROVIDER_IDS;
    const customIds = allProviderIds.filter(
      (id) => !builtinIds.includes(id),
    );

    new Setting(containerEl)
      .setName('Active provider / model')
      .setDesc('Sets the default selection in the chat. You can also switch inline from the chat input.')
      .addDropdown((dd) => {
        for (const [id, cfg] of Object.entries(providers)) {
          if (cfg.enabledModels.length === 0) continue;
          const sorted = [...cfg.enabledModels].sort((a, b) => {
            const nameA = getModelName(id, a);
            const nameB = getModelName(id, b);
            return nameA.localeCompare(nameB);
          });
          for (const modelId of sorted) {
            dd.addOption(`${id}::${modelId}`, `${cfg.name} — ${getModelName(id, modelId)}`);
          }
        }
        const { activeProviderId } = settings;
        const { [activeProviderId]: activeCfg } = providers;
        dd.setValue(`${activeProviderId}::${activeCfg.defaultModel}`);
        dd.onChange(async (value) => {
          const [providerId = '', modelId = ''] = value.split('::');
          this.plugin.settings.activeProviderId = providerId;
          providers[providerId].defaultModel = modelId;
          await this.plugin.saveSettings();
        });
      });

    // ─── Built-in providers ───────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Built-in providers' });

    for (const id of BUILTIN_PROVIDER_IDS) {
      this.renderProviderSection(containerEl, id, false);
    }

    // ─── Custom OpenAI-compatible providers ───────────────────────────────

    const customSection = containerEl.createEl('details', { cls: 'engram-section-details' });
    const customSummary = customSection.createEl('summary', { cls: 'engram-section-summary' });
    customSummary.createSpan({ cls: 'engram-section-summary-name', text: 'Custom providers' });
    if (customIds.length > 0) {
      customSummary.createSpan({ cls: 'engram-section-count', text: String(customIds.length) });
    }
    const customInner = customSection.createDiv({ cls: 'engram-section-inner' });
    customInner.createEl('p', {
      text: 'Add any OpenAI-compatible endpoint — Ollama, vLLM, custom deployments, etc.',
      cls: 'setting-item-description',
    });

    // "Add" form always anchored immediately below the heading
    this.renderAddProviderForm(customInner);

    for (const id of customIds) {
      this.renderProviderSection(customInner, id, true);
    }

    // ─── Memory ───────────────────────────────────────────────────────────

    containerEl.createEl('h2', { text: 'Memory' });

    new Setting(containerEl)
      .setName('Max memory count')
      .setDesc(
        'Maximum non-core messages to include in context. 0 = unlimited. Core messages are always included.',
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, MAX_MEMORY_COUNT, 1)
          .setValue(this.plugin.settings.maxMemoryCount)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxMemoryCount = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Memory extraction')
      .setDesc('Automatically extract facts/entities after each assistant response.')
      .addDropdown((dd) =>
        dd
          .addOptions({
            auto: 'Automatic',
            manual: 'Manual (button)',
            disabled: 'Disabled',
          })
          .setValue(this.plugin.settings.memoryExtractionMode)
          .onChange(async (value) => {
            this.plugin.settings.memoryExtractionMode = parseExtractionMode(value);
            await this.plugin.saveSettings();
          }),
      );

    // ─── Vault ────────────────────────────────────────────────────────────

    containerEl.createEl('h2', { text: 'Vault' });

    new Setting(containerEl)
      .setName('Engram root directory')
      .setDesc(
        'Subdirectory of your vault where Engram stores memories and conversations.',
      )
      .addText((text) =>
        text
          .setPlaceholder('engram')
          .setValue(this.plugin.settings.engramRoot)
          .onChange(async (value) => {
            this.plugin.settings.engramRoot = value.length === 0
              ? DEFAULT_SETTINGS.engramRoot
              : value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Autosave conversations')
      .setDesc('Periodically save the active conversation to the vault.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autosaveEnabled)
          .onChange(async (value) => {
            this.plugin.settings.autosaveEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    // ─── Completion defaults ──────────────────────────────────────────────

    containerEl.createEl('h2', { text: 'Completion defaults' });
    containerEl.createEl('p', {
      text: 'These apply when no per-conversation override is set in the chat panel.',
      cls: 'setting-item-description',
    });

    new Setting(containerEl)
      .setName('Default system prompt')
      .setDesc('Sent as the system message at the start of every conversation.')
      .addTextArea((t) =>
        t
          .setPlaceholder('You are a helpful assistant…')
          .setValue(this.plugin.settings.defaultPreamble)
          .onChange(async (value) => {
            this.plugin.settings.defaultPreamble = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Temperature')
      .setDesc('Leave the chat override empty to use this value.')
      .addSlider((slider) =>
        slider
          .setLimits(0, TEMPERATURE_MAX, TEMPERATURE_STEP)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.temperature = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Max response tokens')
      .setDesc('Leave the chat override empty to use this value.')
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange(async (value) => {
            const parsed = parseInt(value, 10);
            if (!Number.isNaN(parsed) && parsed > 0) {
              this.plugin.settings.maxTokens = parsed;
              await this.plugin.saveSettings();
            }
          }),
      );
  }

  // ─── Per-provider accordion section ───────────────────────────────────────

  private renderProviderSection(
    containerEl: HTMLElement,
    id: string,
    canRemove: boolean,
  ): void {
    const { plugin } = this;
    const { settings } = plugin;
    const { providers, activeProviderId } = settings;
    const { [id]: cfg } = providers;
    const isActive = id === activeProviderId;

    const details = containerEl.createEl('details', { cls: 'engram-provider-details' });
    const summary = details.createEl('summary', { cls: 'engram-provider-summary' });
    summary.createSpan({ cls: 'engram-provider-summary-name', text: cfg.name });
    if (isActive) {
      summary.createSpan({ cls: 'engram-provider-active-badge', text: 'active' });
    }

    const inner = details.createDiv({ cls: 'engram-provider-inner' });

    if (canRemove) {
      new Setting(inner)
        .setName('Remove provider')
        .addButton((btn) =>
          btn
            .setButtonText('Remove')
            .setClass('mod-warning')
            .onClick(async () => {
              this.plugin.settings.providers = removeProvider(
                this.plugin.settings.providers,
                id,
              );
              this.plugin.providers.delete(id);
              if (activeProviderId === id) {
                this.plugin.settings.activeProviderId = 'openrouter';
              }
              await this.plugin.saveSettings();
              this.plugin.refreshChatView();
              this.display();
            }),
        );
    }

    if (id === 'openrouter') {
      inner.createEl('p', {
        text: 'Routes requests to 200+ models via a single API key. Get yours at openrouter.ai/keys.',
        cls: 'setting-item-description',
      });
    } else if (id !== 'anthropic') {
      new Setting(inner)
        .setName('Base URL')
        .setDesc('OpenAI-compatible API base (without /v1).')
        .addText((text) =>
          text
            .setPlaceholder('http://localhost:11434')
            .setValue(cfg.baseUrl ?? '')
            .onChange(async (value) => {
              cfg.baseUrl = value;
              this.plugin.reinitializeProvider(id);
              await this.plugin.saveSettings();
            }),
        );
    }

    const apiKeySetting = new Setting(inner)
      .setName('API Key')
      .setDesc("Stored in Obsidian's SecretStorage (per-device, not synced).");
    new SecretComponent(this.app, apiKeySetting.controlEl)
      .setValue(cfg.apiKeySecret ?? '')
      .onChange(async (value) => {
        cfg.apiKeySecret = value;
        this.plugin.reinitializeProvider(id);
        await this.plugin.saveSettings();
      });

    this.renderModelSection(inner, id);
  }

  // ─── Add custom provider form ──────────────────────────────────────────────

  private renderAddProviderForm(containerEl: HTMLElement): void {
    let newName = '';
    let newUrl = '';

    new Setting(containerEl)
      .setName('Add custom provider')
      .setDesc('Name it after the service (e.g. Ollama). The name becomes its ID slug.')
      .addText((t) =>
        t
          .setPlaceholder('Name')
          .onChange((v) => {
            newName = v.trim();
          }),
      )
      .addText((t) =>
        t
          .setPlaceholder('Base URL (e.g. http://localhost:11434)')
          .onChange((v) => {
            newUrl = v.trim();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText('Add').onClick(async () => {
          if (newName.length === 0) return;
          const id = slugifyProviderId(newName);
          if (Object.hasOwn(this.plugin.settings.providers, id)) return;
          const newProvider: ProviderSettings = {
            id,
            name: newName,
            baseUrl: newUrl.length === 0 ? DEFAULT_CUSTOM_PROVIDER_URL : newUrl,
            defaultModel: '',
            enabledModels: [],
            customModels: [],
          };
          this.plugin.settings.providers[id] = newProvider;
          this.plugin.reinitializeProvider(id);
          await this.plugin.saveSettings();
          this.plugin.refreshChatView();
          this.display();
        }),
      );
  }

  // ─── Model management section ──────────────────────────────────────────────

  private renderModelSection(containerEl: HTMLElement, id: string): void {
    const { plugin } = this;
    const { settings } = plugin;
    const { providers } = settings;
    const { [id]: cfg } = providers;
    const knownModels = KNOWN_MODELS[id] ?? [];

    const getModelNameForProvider = (mid: string): string =>
      knownModels.find((m) => m.id === mid)?.name ?? mid;

    containerEl.createEl('h4', { text: 'Models' });

    // Known models sorted alphabetically by display name
    const sortedKnown = [...knownModels].sort((a, b) => a.name.localeCompare(b.name));

    for (const model of sortedKnown) {
      const desc = model.contextWindow === undefined
        ? model.id
        : `${model.id} · ${Math.round(model.contextWindow / CONTEXT_WINDOW_DIVISOR)}K ctx`;

      new Setting(containerEl)
        .setName(model.name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(cfg.enabledModels.includes(model.id)).onChange(async (on) => {
            if (on) {
              if (!cfg.enabledModels.includes(model.id)) cfg.enabledModels.push(model.id);
            } else {
              cfg.enabledModels = cfg.enabledModels.filter((m) => m !== model.id);
              if (cfg.defaultModel === model.id) cfg.defaultModel = firstModelOrEmpty(cfg.enabledModels);
            }
            await this.plugin.saveSettings();
            this.plugin.refreshChatView();
            this.display();
          }),
        );
    }

    // Custom model entries sorted alphabetically, each removable
    const sortedCustom = [...cfg.customModels].sort((a, b) => a.localeCompare(b));

    for (const customId of sortedCustom) {
      new Setting(containerEl)
        .setName(customId)
        .setDesc('Custom model')
        .addExtraButton((btn) =>
          btn
            .setIcon('trash')
            .setTooltip('Remove')
            .onClick(async () => {
              cfg.customModels = cfg.customModels.filter((m) => m !== customId);
              cfg.enabledModels = cfg.enabledModels.filter((m) => m !== customId);
              if (cfg.defaultModel === customId) cfg.defaultModel = firstModelOrEmpty(cfg.enabledModels);
              await this.plugin.saveSettings();
              this.plugin.refreshChatView();
              this.display();
            }),
        );
    }

    // Add custom model
    let newModelId = '';
    new Setting(containerEl)
      .setName('Add custom model')
      .setDesc('Enter any model ID supported by this endpoint.')
      .addText((t) =>
        t
          .setPlaceholder('model-id or org/model-id')
          .onChange((v) => {
            newModelId = v.trim();
          }),
      )
      .addButton((btn) =>
        btn.setButtonText('Add').onClick(async () => {
          if (newModelId.length === 0 || cfg.customModels.includes(newModelId)) return;
          cfg.customModels.push(newModelId);
          cfg.enabledModels.push(newModelId);
          if (cfg.defaultModel.length === 0) {
            cfg.defaultModel = newModelId;
          }
          newModelId = '';
          await this.plugin.saveSettings();
          this.plugin.refreshChatView();
          this.display();
        }),
      );

    // Default model dropdown (from enabled models, sorted alpha) or text fallback
    const sortedEnabled = [...cfg.enabledModels].sort((a, b) =>
      getModelNameForProvider(a).localeCompare(getModelNameForProvider(b)),
    );

    if (sortedEnabled.length > 0) {
      new Setting(containerEl)
        .setName('Default model')
        .setDesc('Pre-selected when switching to this provider in the chat.')
        .addDropdown((dd) => {
          for (const mid of sortedEnabled) dd.addOption(mid, getModelNameForProvider(mid));
          dd.setValue(cfg.defaultModel.length > 0 ? cfg.defaultModel : firstModelOrEmpty(sortedEnabled));
          dd.onChange(async (value) => {
            cfg.defaultModel = value;
            await this.plugin.saveSettings();
            this.plugin.refreshChatView();
          });
        });
    } else {
      new Setting(containerEl)
        .setName('Default model')
        .setDesc('No models enabled. Toggle models above or add a custom model ID.')
        .addText((t) =>
          t
            .setPlaceholder('model-id')
            .setValue(cfg.defaultModel)
            .onChange(async (value) => {
              cfg.defaultModel = value;
              await this.plugin.saveSettings();
            }),
        );
    }
  }
}

function parseExtractionMode(value: string): 'auto' | 'manual' | 'disabled' {
  switch (value) {
    case 'auto':
    case 'disabled':
      return value;
    default:
      return 'manual';
  }
}

function slugifyProviderId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gv, '-');
}

function firstModelOrEmpty(modelIds: string[]): string {
  return modelIds[0] ?? '';
}

function getModelName(providerId: string, modelId: string): string {
  const knownModels = KNOWN_MODELS[providerId] ?? [];
  return knownModels.find((model) => model.id === modelId)?.name ?? modelId;
}

function removeProvider(
  providers: Record<string, ProviderSettings>,
  providerId: string,
): Record<string, ProviderSettings> {
  return Object.fromEntries(
    Object.entries(providers).filter(([id]) => id !== providerId),
  );
}
