import {
  getAllProviders,
  getModelsByProvider,
  getProvider,
  getProviderModelId,
} from 'model-metadata-central';
import type { ModelMetadata, ProviderMetadata } from 'model-metadata-central';

const PROVIDER_ALIASES: Record<string, string> = {
  mistral: 'mistralai',
};

export interface KnownModel {
  id: string;
  name: string;
  contextWindow?: number;
}

export interface ProviderDefaults {
  name: string;
  baseUrl?: string;
  apiType: 'anthropic' | 'openai_compatible';
}

const VERSION_SUFFIX_PATTERN = /\/v1\/?$/u;

function toMmcId(pluginProviderId: string): string {
  return PROVIDER_ALIASES[pluginProviderId] ?? pluginProviderId;
}

function stripVersion(url: string | undefined): string | undefined {
  return url?.replace(VERSION_SUFFIX_PATTERN, '');
}

function formatModel(model: ModelMetadata, idOnProvider: string): KnownModel {
  return {
    id: idOnProvider,
    name: model.model_name ?? model.model_id,
    contextWindow: model.context_window,
  };
}

export function getKnownModels(pluginProviderId: string): KnownModel[] {
  const mmcId = toMmcId(pluginProviderId);
  const result: KnownModel[] = [];

  for (const model of getModelsByProvider(mmcId)) {
    if (model.deprecated === true) {
      continue;
    }

    const idOnProvider = getProviderModelId(model.model_id, mmcId) ?? model.model_id;
    result.push(formatModel(model, idOnProvider));
  }

  return result;
}

export function getProviderDefaults(
  pluginProviderId: string,
): ProviderDefaults | undefined {
  const provider = getProvider(toMmcId(pluginProviderId));
  if (provider === undefined) {
    return undefined;
  }

  return {
    name: provider.name,
    baseUrl: stripVersion(provider.base_url),
    apiType: provider.api_type === 'anthropic' ? 'anthropic' : 'openai_compatible',
  };
}

export function getApiType(
  pluginProviderId: string,
): ProviderDefaults['apiType'] {
  return getProviderDefaults(pluginProviderId)?.apiType ?? 'openai_compatible';
}

export function getAllMmcProviders(): readonly ProviderMetadata[] {
  return getAllProviders();
}
