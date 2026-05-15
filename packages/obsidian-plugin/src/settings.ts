import { type App, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type EngramPlugin from './main';
import { DEFAULT_SETTINGS, KNOWN_MODELS, BUILTIN_PROVIDER_IDS } from './constants';
import type { ProviderSettings } from './constants';
import { renderDreamsModelDefaults } from './dreams-settings';
import { renderModelSection } from './settings-models';

const MAX_MEMORY_COUNT = 50;
const TEMPERATURE_MAX = 2;
const TEMPERATURE_STEP = 0.1;
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
    const openProviderIds = this.captureOpenProviderIds();
    const customSectionOpen = this.captureCustomSectionOpen();
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
          this.refreshModelBackedViews();
        });
      });

    // ─── Built-in providers ───────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Built-in providers' });

    for (const id of BUILTIN_PROVIDER_IDS) {
      this.renderProviderSection(containerEl, id, false, openProviderIds.has(id));
    }

    // ─── Custom OpenAI-compatible providers ───────────────────────────────

    const customSection = containerEl.createEl('details', { cls: 'engram-section-details' });
    if (customSectionOpen) customSection.setAttribute('open', '');
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
      this.renderProviderSection(customInner, id, true, openProviderIds.has(id));
    }

    // ─── Dreams ───────────────────────────────────────────────────────────

    containerEl.createEl('h2', { text: 'Dreams' });
    containerEl.createEl('p', {
      text: 'Pick the default analysis model for Dream planning, plus an optional separate narrative model for the dream text itself.',
      cls: 'setting-item-description',
    });

    renderDreamsModelDefaults(containerEl, this.plugin, () => {
      this.display();
    });

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

    new Setting(containerEl)
      .setName('Tool calling')
      .setDesc(
        'Expose Engram memory tools (memory, thread, scratch, etc.) to the model during chat. '
          + 'Disables thinking mode on Anthropic when enabled.',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.toolCallingEnabled)
          .onChange(async (value) => {
            this.plugin.settings.toolCallingEnabled = value;
            await this.plugin.saveSettings();
          }),
      );
  }

  // ─── Accordion open-state preservation ─────────────────────────────────────

  private captureOpenProviderIds(): Set<string> {
    const open = new Set<string>();
    const nodes = this.containerEl.querySelectorAll<HTMLDetailsElement>(
      'details[data-provider-id]',
    );
    nodes.forEach((el) => {
      if (el.open && el.dataset.providerId !== undefined) {
        open.add(el.dataset.providerId);
      }
    });
    return open;
  }

  private captureCustomSectionOpen(): boolean {
    const el = this.containerEl.querySelector<HTMLDetailsElement>(
      'details.engram-section-details',
    );
    return el?.open ?? false;
  }

  // ─── Per-provider accordion section ───────────────────────────────────────

  private renderProviderSection(
    containerEl: HTMLElement,
    id: string,
    canRemove: boolean,
    open: boolean,
  ): void {
    const { plugin } = this;
    const { settings } = plugin;
    const { providers, activeProviderId } = settings;
    const { [id]: cfg } = providers;
    const isActive = id === activeProviderId;

    const details = containerEl.createEl('details', {
      cls: 'engram-provider-details',
      attr: { 'data-provider-id': id },
    });
    if (open) details.setAttribute('open', '');
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
              this.refreshModelBackedViews();
              this.display();
            }),
        );
    }

    if (id === 'openrouter') {
      inner.createEl('p', {
        text: 'Routes requests to 200+ models via a single API key. Get yours at openrouter.ai/keys.',
        cls: 'setting-item-description',
      });
    } else {
      new Setting(inner)
        .setName('Base URL')
        .setDesc('API base URL (without /v1).')
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

    renderModelSection(inner, id, this.plugin, {
      onRefresh: () => { this.refreshModelBackedViews(); },
      redisplay: () => { this.display(); },
    });
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
          this.refreshModelBackedViews();
          this.display();
        }),
      );
  }

  private refreshModelBackedViews(): void {
    this.plugin.refreshEngramView('chat');
    this.plugin.refreshEngramView('memories');
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
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-');
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
