import { requestUrl } from 'obsidian';
import type { ChatMessage } from '@interwebalchemy/engram-core';
import type {
  ProviderAdapter,
  ProviderConfig,
  CompletionConfig,
  CompletionResult,
  ExtendedChatMessage,
  StopReason,
  StreamChunk,
  ToolDefinition,
  ToolUseEvent,
  Model,
} from './types';
import {
  getNumber,
  getRecord,
  getRecords,
  getString,
  isRecord,
  safeJsonParse,
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
    const body = buildOpenAIRequestBody(messages as ExtendedChatMessage[], config, false);
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
    messages: ExtendedChatMessage[],
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

    const state = createOpenAIStreamState();
    for await (const payload of streamSsePayloads(response.body)) {
      if (payload === OPENAI_DONE_PAYLOAD) {
        yield* flushPendingOpenAIToolCalls(state);
        yield { content: '', done: true, stopReason: state.stopReason };
        return;
      }

      const chunks = parseOpenAIStreamEvent(payload, state);
      for (const chunk of chunks) {
        yield chunk;
      }
    }

    yield* flushPendingOpenAIToolCalls(state);
    yield { content: '', done: true, stopReason: state.stopReason };
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
  messages: ExtendedChatMessage[],
  config: CompletionConfig,
  stream: boolean,
): Record<string, unknown> {
  const {
    temperature,
    maxTokens,
    topP,
    frequencyPenalty,
    presencePenalty,
    tools,
  } = config;
  const body: Record<string, unknown> = {
    model: config.model,
    messages: serializeOpenAIMessages(messages),
    stream,
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (maxTokens !== undefined) body.max_tokens = maxTokens;
  if (topP !== undefined) body.top_p = topP;
  if (frequencyPenalty !== undefined) body.frequency_penalty = frequencyPenalty;
  if (presencePenalty !== undefined) body.presence_penalty = presencePenalty;
  if (tools !== undefined && tools.length > 0) {
    body.tools = tools.map(toOpenAITool);
    body.tool_choice = 'auto';
  }
  return body;
}

function serializeOpenAIMessages(
  messages: ExtendedChatMessage[],
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    const { role, content, toolUses, toolResults } = message;

    if (toolResults !== undefined && toolResults.length > 0) {
      for (const result of toolResults) {
        out.push({
          role: 'tool',
          tool_call_id: result.toolUseId,
          content: result.content,
        });
      }
      continue;
    }

    if (role === 'assistant' && toolUses !== undefined && toolUses.length > 0) {
      out.push({
        role,
        content: content.length === 0 ? null : content,
        tool_calls: toolUses.map((toolUse) => ({
          id: toolUse.id,
          type: 'function',
          function: {
            name: toolUse.name,
            arguments: JSON.stringify(toolUse.input),
          },
        })),
      });
      continue;
    }

    out.push({ role, content });
  }
  return out;
}

function toOpenAITool(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
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

interface OpenAIToolCallBuffer {
  id: string | undefined;
  name: string | undefined;
  partialJson: string;
}

class OpenAIStreamState {
  private readonly toolCalls = new Map<number, OpenAIToolCallBuffer>();
  private currentStopReason: StopReason | undefined;

  get stopReason(): StopReason | undefined {
    return this.currentStopReason;
  }

  setStopReason(raw: string): void {
    this.currentStopReason = normalizeOpenAIFinishReason(raw);
  }

  accumulateToolDelta(
    index: number,
    id: string | undefined,
    name: string | undefined,
    partialJson: string,
  ): void {
    const buffer = this.toolCalls.get(index) ?? {
      id: undefined,
      name: undefined,
      partialJson: '',
    };
    if (id !== undefined && id.length > 0) {
      buffer.id = id;
    }
    if (name !== undefined && name.length > 0) {
      buffer.name = name;
    }
    buffer.partialJson += partialJson;
    this.toolCalls.set(index, buffer);
  }

  *drainToolCalls(): Generator<StreamChunk> {
    const indexes = [...this.toolCalls.keys()].sort((a, b) => a - b);
    for (const index of indexes) {
      const buffer = this.toolCalls.get(index);
      this.toolCalls.delete(index);
      if (buffer === undefined) {
        continue;
      }
      const toolUse = finalizeOpenAIToolCall(buffer);
      if (toolUse !== null) {
        yield { content: '', done: false, toolUse };
      }
    }
  }
}

function createOpenAIStreamState(): OpenAIStreamState {
  return new OpenAIStreamState();
}

function parseOpenAIStreamEvent(
  payload: string,
  state: OpenAIStreamState,
): StreamChunk[] {
  const parsed = safeJsonParse(payload);
  if (parsed === null || !isRecord(parsed)) {
    return [];
  }

  const choices = getRecords(parsed, 'choices');
  const [firstChoice = {}] = choices;
  const finishReason = getString(firstChoice, 'finish_reason');
  if (finishReason !== undefined) {
    state.setStopReason(finishReason);
  }

  const delta = getRecord(firstChoice, 'delta');
  if (delta === undefined) {
    return [];
  }

  const chunks: StreamChunk[] = [];
  accumulateOpenAIToolDeltas(delta, state);
  const textChunk = parseOpenAIDeltaChunk(delta);
  if (textChunk !== null) {
    chunks.push(textChunk);
  }

  if (state.stopReason === 'tool_use') {
    chunks.push(...state.drainToolCalls());
  }
  return chunks;
}

function accumulateOpenAIToolDeltas(
  delta: Record<string, unknown>,
  state: OpenAIStreamState,
): void {
  const toolCalls = getRecords(delta, 'tool_calls');
  for (const toolCall of toolCalls) {
    const index = getNumber(toolCall, 'index') ?? 0;
    const id = getString(toolCall, 'id');
    const functionRecord = getRecord(toolCall, 'function');
    const name = functionRecord === undefined ? undefined : getString(functionRecord, 'name');
    const partialJson = functionRecord === undefined
      ? ''
      : getString(functionRecord, 'arguments') ?? '';
    state.accumulateToolDelta(index, id, name, partialJson);
  }
}

function* flushPendingOpenAIToolCalls(
  state: OpenAIStreamState,
): Generator<StreamChunk> {
  yield* state.drainToolCalls();
}

function finalizeOpenAIToolCall(buffer: OpenAIToolCallBuffer): ToolUseEvent | null {
  const { id, name, partialJson } = buffer;
  if (id === undefined || name === undefined) {
    return null;
  }
  const raw = partialJson.length === 0 ? '{}' : partialJson;
  try {
    const input: unknown = JSON.parse(raw);
    if (!isRecord(input)) {
      return null;
    }
    return { id, name, input };
  } catch {
    return null;
  }
}

function normalizeOpenAIFinishReason(raw: string): StopReason {
  switch (raw) {
    case 'stop':
      return 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'length';
    default:
      return 'other';
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
