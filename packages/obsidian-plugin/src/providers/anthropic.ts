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

const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const THINKING_MIN_TOKENS = 1280;
const DEFAULT_MAX_TOKENS = 16000;
const MAX_BUDGET_TOKENS = 10000;
const BUDGET_RATIO = 0.8;

const ANTHROPIC_MODELS: Model[] = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', contextWindow: 200000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000 },
  { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', contextWindow: 200000 },
];

/**
 * Adapter for the Anthropic Messages API.
 *
 * Anthropic uses a different request format from OpenAI:
 * - System prompt is a top-level `system` field, not a message
 * - Streaming uses SSE with `content_block_delta` events
 * - No /v1/models endpoint (model list is static)
 */
export class AnthropicAdapter implements ProviderAdapter {
  readonly id: string;
  readonly name: string;
  private apiKey: string;
  private readonly models = ANTHROPIC_MODELS;

  constructor(config: ProviderConfig) {
    const {
      id,
      name,
      apiKey = '',
    } = config;
    this.id = id;
    this.name = name;
    this.apiKey = apiKey;
  }

  updateConfig(config: Partial<ProviderConfig>): void {
    const { apiKey } = config;
    if (apiKey !== undefined) this.apiKey = apiKey;
  }

  // ─── Completion ─────────────────────────────────────────────────────────

  async complete(
    messages: ChatMessage[],
    config: CompletionConfig,
  ): Promise<CompletionResult> {
    const body = buildAnthropicRequestBody(messages, config, false);
    const response = await requestUrl({
      url: `${ANTHROPIC_API_URL}/v1/messages`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    return parseAnthropicCompletionResponse(response.json, config.model);
  }

  // ─── Streaming ──────────────────────────────────────────────────────────

  async *stream(
    messages: ChatMessage[],
    config: CompletionConfig,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const body = buildAnthropicRequestBody(messages, config, true);

    const response = await fetch(`${ANTHROPIC_API_URL}/v1/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${error}`);
    }

    if (response.body === null) {
      throw new Error('No response body');
    }

    for await (const payload of streamSsePayloads(response.body)) {
      const chunk = parseAnthropicStreamChunk(payload);
      if (chunk === null) {
        continue;
      }
      if (chunk.done) {
        yield chunk;
        return;
      }

      yield chunk;
    }

    yield { content: '', done: true };
  }

  // ─── Model listing ──────────────────────────────────────────────────────

  async listModels(): Promise<Model[]> {
    return await Promise.resolve(this.models);
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
    };
  }

}

function buildAnthropicRequestBody(
  messages: ChatMessage[],
  config: CompletionConfig,
  stream: boolean,
): Record<string, unknown> {
  const {
    systemMessages,
    conversationMessages,
  } = splitAnthropicMessages(messages);
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  const useThinking = maxTokens >= THINKING_MIN_TOKENS;
  const budgetTokens = Math.min(MAX_BUDGET_TOKENS, Math.floor(maxTokens * BUDGET_RATIO));

  const body: Record<string, unknown> = {
    model: config.model,
    messages: conversationMessages,
    max_tokens: maxTokens,
    stream,
    ...(useThinking
      ? {
          thinking: { type: 'enabled', budget_tokens: budgetTokens },
          temperature: 1,
        }
        : {
            temperature: config.temperature ?? 1,
          }),
  };
  if (systemMessages.length > 0) body.system = systemMessages.join('\n\n');
  const { topP } = config;
  if (topP !== undefined) body.top_p = topP;
  return body;
}

function splitAnthropicMessages(messages: ChatMessage[]): {
  systemMessages: string[];
  conversationMessages: Array<{ role: string; content: string }>;
} {
  const systemMessages: string[] = [];
  const conversationMessages: Array<{ role: string; content: string }> = [];

  for (const { role, content } of messages) {
    if (role === 'system') {
      systemMessages.push(content);
    } else {
      conversationMessages.push({ role, content });
    }
  }

  return { systemMessages, conversationMessages };
}

function parseAnthropicCompletionResponse(
  raw: unknown,
  fallbackModel: string,
): CompletionResult {
  const response = isRecord(raw) ? raw : {};
  const content = getRecords(response, 'content')
    .map((block) => getString(block, 'text') ?? '')
    .join('');
  const model = getString(response, 'model') ?? fallbackModel;
  const usageRecord = getRecord(response, 'usage');
  return {
    content,
    model,
    usage: usageRecord === undefined ? undefined : parseAnthropicUsage(usageRecord),
  };
}

function parseAnthropicUsage(
  usageRecord: Record<string, unknown>,
): CompletionResult['usage'] | undefined {
  const promptTokens = getNumber(usageRecord, 'input_tokens');
  const completionTokens = getNumber(usageRecord, 'output_tokens');
  if (promptTokens === undefined || completionTokens === undefined) {
    return undefined;
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function parseAnthropicStreamChunk(payload: string): StreamChunk | null {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (!isRecord(parsed)) {
      return null;
    }

    const eventType = getString(parsed, 'type');
    if (eventType === 'message_stop') {
      return { content: '', done: true };
    }
    if (eventType !== 'content_block_delta') {
      return null;
    }

    const delta = getRecord(parsed, 'delta');
    if (delta === undefined) {
      return null;
    }

    return parseAnthropicDeltaChunk(delta);
  } catch {
    return null;
  }
}

function parseAnthropicDeltaChunk(
  delta: Record<string, unknown>,
): StreamChunk | null {
  const deltaType = getString(delta, 'type');
  if (deltaType === 'thinking_delta') {
    const thinking = getString(delta, 'thinking') ?? '';
    return thinking.length === 0 ? null : { content: '', reasoning: thinking, done: false };
  }

  const text = getString(delta, 'text') ?? '';
  return text.length === 0 ? null : { content: text, done: false };
}
