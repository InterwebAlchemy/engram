import type EngramPlugin from '../main';
import {
  findSelectedOption,
  getModelOptions,
  normalizeDreamModelSettings,
  type ModelOption,
  type ModelSelection,
} from './dreams-view-support';

export interface DreamSelectionState {
  analysisSelection: ModelSelection;
  narrativeSelection: ModelSelection;
}

export function getNarrativeOverrideOption(
  plugin: EngramPlugin,
  state: DreamSelectionState,
): ModelOption | null {
  const {
    analysisSelection,
    narrativeSelection,
  } = state;
  if (
    narrativeSelection.providerId.length === 0 ||
    narrativeSelection.modelId.length === 0
  ) {
    return null;
  }

  const options = getModelOptions(plugin.settings);
  const match = findSelectedOption(options, narrativeSelection);
  if (match === null) {
    return null;
  }

  return match.providerId === analysisSelection.providerId &&
    match.modelId === analysisSelection.modelId
    ? null
    : match;
}

export function updateAnalysisSelection(
  state: DreamSelectionState,
  providerId: string,
  modelId: string,
): DreamSelectionState {
  const analysisSelection = { providerId, modelId };
  const {
    narrativeSelection,
  } = state;
  const normalizedNarrativeSelection =
    narrativeSelection.providerId === providerId &&
    narrativeSelection.modelId === modelId
      ? { providerId: '', modelId: '' }
      : narrativeSelection;

  return {
    analysisSelection,
    narrativeSelection: normalizedNarrativeSelection,
  };
}

export function updateNarrativeSelection(
  state: DreamSelectionState,
  providerId: string,
  modelId: string,
): DreamSelectionState {
  const { analysisSelection } = state;
  const useAnalysisSelection =
    providerId.length === 0 ||
    modelId.length === 0 ||
    (
      providerId === analysisSelection.providerId &&
      modelId === analysisSelection.modelId
    );

  return {
    analysisSelection,
    narrativeSelection: useAnalysisSelection
      ? { providerId: '', modelId: '' }
      : { providerId, modelId },
  };
}

export function persistDreamSelectionSettings(
  plugin: EngramPlugin,
  state: DreamSelectionState,
): void {
  const {
    analysisSelection,
    narrativeSelection,
  } = state;
  const next = normalizeDreamModelSettings({
    ...plugin.settings,
    dreams: {
      analysisProviderId: analysisSelection.providerId,
      analysisModelId: analysisSelection.modelId,
      narrativeProviderId: narrativeSelection.providerId,
      narrativeModelId: narrativeSelection.modelId,
    },
  });
  const {
    settings,
  } = plugin;
  const { dreams } = settings;
  if (
    dreams.analysisProviderId === next.analysisProviderId &&
    dreams.analysisModelId === next.analysisModelId &&
    dreams.narrativeProviderId === next.narrativeProviderId &&
    dreams.narrativeModelId === next.narrativeModelId
  ) {
    return;
  }
  settings.dreams = next;
  void plugin.saveSettings();
}
