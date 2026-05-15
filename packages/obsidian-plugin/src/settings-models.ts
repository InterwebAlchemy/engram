import { Setting } from 'obsidian';
import { KNOWN_MODELS } from './constants';
import type EngramPlugin from './main';

const CONTEXT_WINDOW_DIVISOR = 1000;

export interface ModelSectionCallbacks {
  onRefresh: () => void;
  redisplay: () => void;
}

export function renderModelSection(
  containerEl: HTMLElement,
  id: string,
  plugin: EngramPlugin,
  { onRefresh, redisplay }: ModelSectionCallbacks,
): void {
  const { settings } = plugin;
  const { providers } = settings;
  const { [id]: cfg } = providers;
  const knownModels = KNOWN_MODELS[id] ?? [];

  const getModelNameForProvider = (mid: string): string =>
    knownModels.find((m) => m.id === mid)?.name ?? mid;

  containerEl.createEl('h4', { text: 'Models' });

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
          await plugin.saveSettings();
          onRefresh();
          redisplay();
        }),
      );
  }

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
            await plugin.saveSettings();
            onRefresh();
            redisplay();
          }),
      );
  }

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
        await plugin.saveSettings();
        onRefresh();
        redisplay();
      }),
    );

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
          await plugin.saveSettings();
          onRefresh();
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
            await plugin.saveSettings();
          }),
      );
  }
}

function firstModelOrEmpty(modelIds: string[]): string {
  return modelIds[0] ?? '';
}
