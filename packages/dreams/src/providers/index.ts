import { AnthropicProvider } from './anthropic';
import { OpenAICompatProvider } from './openai-compat';
import type { DreamsProvider, DreamsProviderConfig } from './types';

export function createDreamsProvider(
  providerName: 'anthropic' | 'openai',
  config: DreamsProviderConfig,
): DreamsProvider {
  const apiKey =
    config.apiKey ??
    (providerName === 'openai' ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY);

  if (apiKey === undefined || apiKey.length === 0) {
    throw new Error(
      providerName === 'openai'
        ? 'Missing OpenAI-compatible API key. Pass --api-key or set OPENAI_API_KEY / ENGRAM_DREAMS_API_KEY.'
        : 'Missing Anthropic API key. Pass --api-key or set ANTHROPIC_API_KEY / ENGRAM_DREAMS_API_KEY.',
    );
  }

  const resolvedConfig = {
    ...config,
    apiKey,
  };

  if (providerName === 'openai') {
    return new OpenAICompatProvider(resolvedConfig);
  }

  return new AnthropicProvider(resolvedConfig);
}

export type {
  DreamsCompletionResult,
  DreamsMessage,
  DreamsProvider,
  DreamsProviderConfig,
  DreamsUsage,
} from './types';
