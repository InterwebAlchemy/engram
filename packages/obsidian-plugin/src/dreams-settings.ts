import { Setting } from 'obsidian';
import type EngramPlugin from './main';
import {
  getDreamAnalysisSelection,
  getDreamNarrativeSelection,
  getModelOptions,
  normalizeDreamModelSettings,
} from './views/dreams-view-support';

export function renderDreamsModelDefaults(
  containerEl: HTMLElement,
  plugin: EngramPlugin,
  redisplay: () => void,
): void {
  const modelOptions = getModelOptions(plugin.settings);
  const analysisSelection = getDreamAnalysisSelection(plugin.settings, modelOptions);
  const narrativeSelection = getDreamNarrativeSelection(
    plugin.settings,
    modelOptions,
    analysisSelection,
  );

  if (modelOptions.length === 0) {
    new Setting(containerEl)
      .setName('Dreams models')
      .setDesc('No enabled models are available yet. Enable at least one provider/model above.');
    return;
  }

  new Setting(containerEl)
    .setName('Dreams analysis model')
    .setDesc('Used for Dream planning and action generation in the Dreams tab.')
    .addDropdown((dd) => {
      for (const option of modelOptions) {
        dd.addOption(
          buildProviderModelValue(option.providerId, option.modelId),
          `${option.providerName} — ${option.modelName}`,
        );
      }
      dd.setValue(buildProviderModelValue(
        analysisSelection.providerId,
        analysisSelection.modelId,
      ));
      dd.onChange(async (value) => {
        const selection = parseProviderModelValue(value);
        const {
          providerId,
          modelId,
        } = selection;
        const {
          settings,
        } = plugin;
        const {
          dreams,
        } = settings;
        const narrativeMatchesAnalysis =
          dreams.narrativeProviderId === providerId &&
          dreams.narrativeModelId === modelId;
        dreams.analysisProviderId = providerId;
        dreams.analysisModelId = modelId;
        if (narrativeMatchesAnalysis) {
          dreams.narrativeProviderId = '';
          dreams.narrativeModelId = '';
        }
        settings.dreams = normalizeDreamModelSettings(settings);
        await plugin.saveSettings();
        plugin.refreshEngramView('memories');
        redisplay();
      });
    });

  new Setting(containerEl)
    .setName('Dreams narrative model')
    .setDesc('Optional override for the final dream prose. Leave on Same as analysis to reuse the Dream planner model.')
    .addDropdown((dd) => {
      dd.addOption('', 'Same as analysis');
      for (const option of modelOptions) {
        dd.addOption(
          buildProviderModelValue(option.providerId, option.modelId),
          `${option.providerName} — ${option.modelName}`,
        );
      }
      dd.setValue(
        narrativeSelection.providerId.length === 0 || narrativeSelection.modelId.length === 0
          ? ''
          : buildProviderModelValue(
            narrativeSelection.providerId,
            narrativeSelection.modelId,
          ),
      );
      dd.onChange(async (value) => {
        const {
          settings,
        } = plugin;
        const {
          dreams,
        } = settings;
        if (value.length === 0) {
          dreams.narrativeProviderId = '';
          dreams.narrativeModelId = '';
        } else {
          const {
            providerId,
            modelId,
          } = parseProviderModelValue(value);
          dreams.narrativeProviderId = providerId;
          dreams.narrativeModelId = modelId;
        }
        settings.dreams = normalizeDreamModelSettings(settings);
        await plugin.saveSettings();
        plugin.refreshEngramView('memories');
        redisplay();
      });
    });
}

function buildProviderModelValue(providerId: string, modelId: string): string {
  return `${providerId}::${modelId}`;
}

function parseProviderModelValue(value: string): { providerId: string; modelId: string } {
  const [providerId = '', modelId = ''] = value.split('::');
  return { providerId, modelId };
}
