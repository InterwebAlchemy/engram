import { App, PluginSettingTab, Setting } from 'obsidian';
import type EngramPlugin from './main';
import { DEFAULT_SETTINGS, KNOWN_MODELS, BUILTIN_PROVIDER_IDS } from './constants';
import type { ProviderSettings } from './constants';

export class EngramSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: EngramPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ─── Active Provider ──────────────────────────────────────────────────

    containerEl.createEl('h2', { text: 'Providers' });

    const allProviderIds = Object.keys(this.plugin.settings.providers);

    new Setting(containerEl)
      .setName('Active provider / model')
      .setDesc('Sets the default selection in the chat. You can also switch inline from the chat input.')
      .addDropdown((dd) => {
        for (const id of allProviderIds) {
          const cfg = this.plugin.settings.providers[id];
          if (cfg.enabledModels.length === 0) continue;
          const sorted = [...cfg.enabledModels].sort((a, b) => {
            const nameA = KNOWN_MODELS[id]?.find((m) => m.id === a)?.name ?? a;
            const nameB = KNOWN_MODELS[id]?.find((m) => m.id === b)?.name ?? b;
            return nameA.localeCompare(nameB);
          });
          for (const modelId of sorted) {
            const knownName = KNOWN_MODELS[id]?.find((m) => m.id === modelId)?.name;
            dd.addOption(`${id}::${modelId}`, `${cfg.name} — ${knownName ?? modelId}`);
          }
        }
        const activeCfg = this.plugin.settings.providers[this.plugin.settings.activeProviderId];
        dd.setValue(`${this.plugin.settings.activeProviderId}::${activeCfg?.defaultModel ?? ''}`);
        dd.onChange(async (value) => {
          const [providerId, modelId] = value.split('::');
          this.plugin.settings.activeProviderId = providerId;
          const cfg = this.plugin.settings.providers[providerId];
          if (cfg) cfg.defaultModel = modelId;
          await this.plugin.saveSettings();
        });
      });

    // ─── Built-in providers ───────────────────────────────────────────────

    containerEl.createEl('h3', { text: 'Built-in providers' });

    for (const id of BUILTIN_PROVIDER_IDS) {
      const cfg = this.plugin.settings.providers[id];
      if (!cfg) continue;
      this.renderProviderSection(containerEl, id, false);
    }

    // ─── Custom OpenAI-compatible providers ───────────────────────────────

    containerEl.createEl('h3', { text: 'Custom providers' });
    containerEl.createEl('p', {
      text: 'Add any OpenAI-compatible endpoint — Ollama, vLLM, custom deployments, etc.',
      cls: 'setting-item-description',
    });

    // "Add" form always anchored immediately below the heading
    this.renderAddProviderForm(containerEl);

    const customIds = allProviderIds.filter(
      (id) => !(BUILTIN_PROVIDER_IDS as readonly string[]).includes(id),
    );
    for (const id of customIds) {
      this.renderProviderSection(containerEl, id, true);
    }

    // ─── Memory ───────────────────────────────────────────────────────────

    containerEl.createEl('h2', { text: 'Memory' });

    new Setting(containerEl)
      .setName('Max memory count')
      .setDesc(
        'Maximum non-core messages to include in context. Core memories are always included.',
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 50, 1)
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
          .onChange(async (value: string) => {
            this.plugin.settings.memoryExtractionMode = value as 'auto' | 'manual' | 'disabled';
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
            this.plugin.settings.engramRoot = value || DEFAULT_SETTINGS.engramRoot;
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
          .setLimits(0, 2, 0.1)
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
            if (!isNaN(parsed) && parsed > 0) {
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
    const cfg = this.plugin.settings.providers[id];
    const isActive = id === this.plugin.settings.activeProviderId;

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
              delete this.plugin.settings.providers[id];
              this.plugin.providers.delete(id);
              if (this.plugin.settings.activeProviderId === id) {
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

    new Setting(inner)
      .setName('API Key')
      .setDesc("Stored in Obsidian's SecretStorage (per-device, not synced).")
      .addText((text) => {
        text.inputEl.type = 'password';
        text.inputEl.autocomplete = 'off';
        this.plugin.getSecret(`${id}-api-key`).then((key) => {
          if (key) text.setValue('••••••••');
        });
        text.onChange(async (value) => {
          if (value && value !== '••••••••') {
            await this.plugin.setSecret(`${id}-api-key`, value);
          }
        });
        return text;
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
          if (!newName) return;
          const id = newName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
          if (this.plugin.settings.providers[id]) return;
          const newProvider: ProviderSettings = {
            id,
            name: newName,
            baseUrl: newUrl || 'http://localhost:11434',
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
    const cfg = this.plugin.settings.providers[id];
    const knownModels = KNOWN_MODELS[id] ?? [];

    const getModelName = (mid: string) =>
      knownModels.find((m) => m.id === mid)?.name ?? mid;

    containerEl.createEl('h4', { text: 'Models' });

    // Known models sorted alphabetically by display name
    const sortedKnown = [...knownModels].sort((a, b) => a.name.localeCompare(b.name));

    for (const model of sortedKnown) {
      const desc = model.contextWindow
        ? `${model.id} · ${Math.round(model.contextWindow / 1000)}K ctx`
        : model.id;

      new Setting(containerEl)
        .setName(model.name)
        .setDesc(desc)
        .addToggle((t) =>
          t.setValue(cfg.enabledModels.includes(model.id)).onChange(async (on) => {
            if (on) {
              if (!cfg.enabledModels.includes(model.id)) cfg.enabledModels.push(model.id);
            } else {
              cfg.enabledModels = cfg.enabledModels.filter((m) => m !== model.id);
              if (cfg.defaultModel === model.id) cfg.defaultModel = cfg.enabledModels[0] ?? '';
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
              if (cfg.defaultModel === customId) cfg.defaultModel = cfg.enabledModels[0] ?? '';
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
          if (!newModelId || cfg.customModels.includes(newModelId)) return;
          cfg.customModels.push(newModelId);
          cfg.enabledModels.push(newModelId);
          if (!cfg.defaultModel) cfg.defaultModel = newModelId;
          newModelId = '';
          await this.plugin.saveSettings();
          this.plugin.refreshChatView();
          this.display();
        }),
      );

    // Default model dropdown (from enabled models, sorted alpha) or text fallback
    const sortedEnabled = [...cfg.enabledModels].sort((a, b) =>
      getModelName(a).localeCompare(getModelName(b)),
    );

    if (sortedEnabled.length > 0) {
      new Setting(containerEl)
        .setName('Default model')
        .setDesc('Pre-selected when switching to this provider in the chat.')
        .addDropdown((dd) => {
          for (const mid of sortedEnabled) dd.addOption(mid, getModelName(mid));
          dd.setValue(cfg.defaultModel || sortedEnabled[0]);
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
