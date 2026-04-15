import { requestUrl } from 'obsidian';
import type { ChatMessage } from '@interwebalchemy/engram-core';
import type {
  ProviderAdapter,
  ProviderConfig,
  CompletionConfig,
  CompletionResult,
  StreamChunk,
  Model,
} from './types';
import {
  getNumber,
  getRecord,
  getRecords,
  getString,
  isRecord,
  streamSsePayloads,
} from './provider-utils';

const OPENAI_API_URL = 'https://api.openai.com';
const TRAILING_SLASH_PATTERN = /\/$/u;
const OPENAI_DONE_PAYLOAD = '[DONE]';

/**
 * Adapter for any endpoint exposing the OpenAI /v1/chat/completions API:
 * LM Studio, Unsloth Studio, OpenRouter, Together, Groq, vLLM, etc.
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  private baseUrl: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    const {
      id,
      name,
      baseUrl = OPENAI_API_URL,
      apiKey = '',
    } = config;
    this.id = id;
    this.name = name;
    this.baseUrl = baseUrl.replace(TRAILING_SLASH_PATTERN, '');
    this.apiKey = apiKey;
  }

  updateConfig(config: Partial<ProviderConfig>): void {
    const {
      baseUrl,
      apiKey,
    } = config;
    if (baseUrl !== undefined) this.baseUrl = baseUrl.replace(TRAILING_SLASH_PATTERN, '');
    if (apiKey !== undefined) this.apiKey = apiKey;
  }

  // ─── Completion ─────────────────────────────────────────────────────────

  async complete(
    messages: ChatMessage[],
    config: CompletionConfig,
  ): Promise<CompletionResult> {
    const body = buildOpenAIRequestBody(messages, config, false);
    const response = await requestUrl({
      url: `${this.baseUrl}/v1/chat/completions`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    return parseOpenAICompletionResponse(response.json, config.model);
  }

  // ─── Streaming ──────────────────────────────────────────────────────────

  async *stream(
    messages: ChatMessage[],
    config: CompletionConfig,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const body = buildOpenAIRequestBody(messages, config, true);

    // Obsidian's requestUrl doesn't support streaming, so we use fetch
    const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${error}`);
    }

    if (response.body === null) {
      throw new Error('No response body');
    }

    for await (const payload of streamSsePayloads(response.body)) {
      if (payload === OPENAI_DONE_PAYLOAD) {
        yield { content: '', done: true };
        return;
      }

      const chunk = parseOpenAIStreamChunk(payload);
      if (chunk !== null) {
        yield chunk;
      }
    }

    yield { content: '', done: true };
  }

  // ─── Model listing ──────────────────────────────────────────────────────

  async listModels(): Promise<Model[]> {
    try {
      const response = await requestUrl({
        url: `${this.baseUrl}/v1/models`,
        method: 'GET',
        headers: this.headers(),
      });

      return parseOpenAIModels(response.json);
    } catch {
      return [];
    }
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey.length > 0) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    return headers;
  }
}

function buildOpenAIRequestBody(
  messages: ChatMessage[],
  config: CompletionConfig,
  stream: boolean,
): Record<string, unknown> {
  const {
    temperature,
    maxTokens,
    topP,
    frequencyPenalty,
    presencePenalty,
  } = config;
  const body: Record<string, unknown> = {
    model: config.model,
    messages: messages.map(({ role, content }) => ({ role, content })),
    stream,
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (topP !== undefined) body.top_p = topP;
  if (frequencyPenalty !== undefined) body.frequency_penalty = frequencyPenalty;
  if (presencePenalty !== undefined) body.presence_penalty = presencePenalty;
  return body;
}

function parseOpenAICompletionResponse(
  raw: unknown,
  fallbackModel: string,
): CompletionResult {
  const response = isRecord(raw) ? raw : {};
  const choices = getRecords(response, 'choices');
  const [firstChoice = {}] = choices;
  const message = getRecord(firstChoice, 'message');
  const content = message === undefined ? '' : getString(message, 'content') ?? '';
  const model = getString(response, 'model') ?? fallbackModel;
  const usageRecord = getRecord(response, 'usage');

  return {
    content,
    model,
    usage: usageRecord === undefined ? undefined : parseOpenAIUsage(usageRecord),
  };
}

function parseOpenAIUsage(
  usageRecord: Record<string, unknown>,
): CompletionResult['usage'] | undefined {
  const promptTokens = getNumber(usageRecord, 'prompt_tokens');
  const completionTokens = getNumber(usageRecord, 'completion_tokens');
  const totalTokens = getNumber(usageRecord, 'total_tokens');
  if (
    promptTokens === undefined ||
    completionTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function parseOpenAIStreamChunk(payload: string): StreamChunk | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) {
      return null;
    }

    const choices = getRecords(parsed, 'choices');
    const [firstChoice = {}] = choices;
    const delta = getRecord(firstChoice, 'delta');
    if (delta === undefined) {
      return null;
    }

    return parseOpenAIDeltaChunk(delta);
  } catch {
    return null;
  }
}

function parseOpenAIModels(raw: unknown): Model[] {
  const response = isRecord(raw) ? raw : {};
  return getRecords(response, 'data').map((modelRecord) => {
    const id = getString(modelRecord, 'id') ?? '';
    const contextWindow = getNumber(modelRecord, 'context_length');
    return {
      id,
      name: id,
      contextWindow,
    };
  }).filter((model) => model.id.length > 0);
}

function parseOpenAIDeltaChunk(
  delta: Record<string, unknown>,
): StreamChunk | null {
  const content = getString(delta, 'content') ?? '';
  const reasoningContent = getString(delta, 'reasoning_content');
  const reasoning = reasoningContent ?? getString(delta, 'reasoning') ?? '';
  if (content.length === 0 && reasoning.length === 0) {
    return null;
  }

  return {
    content,
    reasoning: reasoning.length === 0 ? undefined : reasoning,
    done: false,
  };
}
