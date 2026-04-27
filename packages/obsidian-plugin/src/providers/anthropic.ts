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
import { getKnownModels } from '../services/modelRegistry';

const ANTHROPIC_API_URL = 'https://api.anthropic.com';
const ANTHROPIC_VERSION = '2023-06-01';
const TRAILING_SLASH_PATTERN = /\/$/u;
const THINKING_MIN_TOKENS = 1280;
const DEFAULT_MAX_TOKENS = 16000;
const MAX_BUDGET_TOKENS = 10000;
const BUDGET_RATIO = 0.8;

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
  private baseUrl: string;
  private apiKey: string;

  constructor(config: ProviderConfig) {
    const {
      id,
      name,
      baseUrl = ANTHROPIC_API_URL,
      apiKey = '',
    } = config;
    this.id = id;
    this.name = name;
    this.baseUrl = baseUrl.replace(TRAILING_SLASH_PATTERN, '');
    this.apiKey = apiKey;
  }

  updateConfig(config: Partial<ProviderConfig>): void {
    const { baseUrl, apiKey } = config;
    if (baseUrl !== undefined) this.baseUrl = baseUrl.replace(TRAILING_SLASH_PATTERN, '');
    if (apiKey !== undefined) this.apiKey = apiKey;
  }

  // ─── Completion ─────────────────────────────────────────────────────────

  async complete(
    messages: ChatMessage[],
    config: CompletionConfig,
  ): Promise<CompletionResult> {
    const body = buildAnthropicRequestBody(messages as ExtendedChatMessage[], config, false);
    const response = await requestUrl({
      url: `${this.baseUrl}/v1/messages`,
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    return parseAnthropicCompletionResponse(response.json, config.model);
  }

  // ─── Streaming ──────────────────────────────────────────────────────────

  async *stream(
    messages: ExtendedChatMessage[],
    config: CompletionConfig,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk> {
    const body = buildAnthropicRequestBody(messages, config, true);

    const response = await fetch(`${this.baseUrl}/v1/messages`, {
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

    const state = createAnthropicStreamState();
    for await (const payload of streamSsePayloads(response.body)) {
      const chunks = parseAnthropicStreamEvent(payload, state);
      for (const chunk of chunks) {
        yield chunk;
        if (chunk.done) {
          return;
        }
      }
    }

    yield { content: '', done: true };
  }

  // ─── Model listing ──────────────────────────────────────────────────────

  async listModels(): Promise<Model[]> {
    return await Promise.resolve(getKnownModels(this.id));
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
  messages: ExtendedChatMessage[],
  config: CompletionConfig,
  stream: boolean,
): Record<string, unknown> {
  const {
    systemMessages,
    conversationMessages,
  } = splitAnthropicMessages(messages);
  const maxTokens = config.maxTokens ?? DEFAULT_MAX_TOKENS;
  // Tool-calling requires non-thinking mode; the streaming parser also keeps
  // the tool_use input_json_delta path simpler without interleaved thinking.
  const hasTools = config.tools !== undefined && config.tools.length > 0;
  const useThinking = maxTokens >= THINKING_MIN_TOKENS && !hasTools;
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
  if (hasTools && config.tools !== undefined) {
    body.tools = config.tools.map(toAnthropicTool);
  }
  return body;
}

function toAnthropicTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  };
}

type AnthropicMessageContent = string | Array<Record<string, unknown>>;

interface AnthropicConversationMessage {
  readonly role: string;
  readonly content: AnthropicMessageContent;
}

function splitAnthropicMessages(messages: ExtendedChatMessage[]): {
  systemMessages: string[];
  conversationMessages: AnthropicConversationMessage[];
} {
  const systemMessages: string[] = [];
  const conversationMessages: AnthropicConversationMessage[] = [];

  for (const message of messages) {
    const { role, content } = message;
    if (role === 'system') {
      systemMessages.push(content);
      continue;
    }
    conversationMessages.push({
      role,
      content: buildAnthropicMessageContent(message),
    });
  }

  return { systemMessages, conversationMessages };
}

function buildAnthropicMessageContent(
  message: ExtendedChatMessage,
): AnthropicMessageContent {
  const { content, toolUses, toolResults } = message;

  if (toolResults !== undefined && toolResults.length > 0) {
    return toolResults.map((result) => ({
      type: 'tool_result',
      tool_use_id: result.toolUseId,
      content: result.content,
      ...(result.isError === true ? { is_error: true } : {}),
    }));
  }

  if (toolUses !== undefined && toolUses.length > 0) {
    const blocks: Array<Record<string, unknown>> = [];
    if (content.length > 0) {
      blocks.push({ type: 'text', text: content });
    }
    for (const toolUse of toolUses) {
      blocks.push({
        type: 'tool_use',
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      });
    }
    return blocks;
  }

  return content;
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

interface AnthropicToolBlock {
  readonly id: string;
  readonly name: string;
  partialJson: string;
}

class AnthropicStreamState {
  private readonly toolBlocks = new Map<number, AnthropicToolBlock>();
  private currentStopReason: StopReason | undefined;

  get stopReason(): StopReason | undefined {
    return this.currentStopReason;
  }

  noteToolBlockStart(index: number, id: string, name: string): void {
    this.toolBlocks.set(index, { id, name, partialJson: '' });
  }

  appendToolJson(index: number, partial: string): void {
    const block = this.toolBlocks.get(index);
    if (block !== undefined) {
      block.partialJson += partial;
    }
  }

  finalizeToolBlock(index: number): ToolUseEvent | null {
    const block = this.toolBlocks.get(index);
    if (block === undefined) {
      return null;
    }
    this.toolBlocks.delete(index);
    return finalizeToolUse(block);
  }

  setStopReason(raw: string | undefined): void {
    this.currentStopReason = normalizeAnthropicStopReason(raw);
  }
}

function createAnthropicStreamState(): AnthropicStreamState {
  return new AnthropicStreamState();
}

function parseAnthropicStreamEvent(
  payload: string,
  state: AnthropicStreamState,
): StreamChunk[] {
  const parsed = safeJsonParse(payload);
  if (parsed === null || !isRecord(parsed)) {
    return [];
  }

  const eventType = getString(parsed, 'type');
  switch (eventType) {
    case 'content_block_start':
      handleContentBlockStart(parsed, state);
      return [];
    case 'content_block_delta':
      return handleContentBlockDelta(parsed, state);
    case 'content_block_stop':
      return handleContentBlockStop(parsed, state);
    case 'message_delta':
      handleMessageDelta(parsed, state);
      return [];
    case 'message_stop':
      return [{ content: '', done: true, stopReason: state.stopReason }];
    default:
      return [];
  }
}

function handleContentBlockStart(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
): void {
  const index = getNumber(event, 'index');
  const contentBlock = getRecord(event, 'content_block');
  if (index === undefined || contentBlock === undefined) {
    return;
  }

  if (getString(contentBlock, 'type') !== 'tool_use') {
    return;
  }

  const id = getString(contentBlock, 'id');
  const name = getString(contentBlock, 'name');
  if (id === undefined || name === undefined) {
    return;
  }

  state.noteToolBlockStart(index, id, name);
}

function handleContentBlockDelta(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
): StreamChunk[] {
  const delta = getRecord(event, 'delta');
  if (delta === undefined) {
    return [];
  }

  const deltaType = getString(delta, 'type');
  if (deltaType === 'thinking_delta') {
    return textChunkFromDelta(getString(delta, 'thinking'), 'reasoning');
  }
  if (deltaType === 'text_delta') {
    return textChunkFromDelta(getString(delta, 'text'), 'content');
  }
  if (deltaType === 'input_json_delta') {
    appendInputJsonDelta(event, delta, state);
    return [];
  }

  return [];
}

function textChunkFromDelta(
  value: string | undefined,
  kind: 'content' | 'reasoning',
): StreamChunk[] {
  const text = value ?? '';
  if (text.length === 0) {
    return [];
  }
  return kind === 'content'
    ? [{ content: text, done: false }]
    : [{ content: '', reasoning: text, done: false }];
}

function appendInputJsonDelta(
  event: Record<string, unknown>,
  delta: Record<string, unknown>,
  state: AnthropicStreamState,
): void {
  const index = getNumber(event, 'index');
  if (index === undefined) {
    return;
  }
  state.appendToolJson(index, getString(delta, 'partial_json') ?? '');
}

function handleContentBlockStop(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
): StreamChunk[] {
  const index = getNumber(event, 'index');
  if (index === undefined) {
    return [];
  }
  const toolUse = state.finalizeToolBlock(index);
  return toolUse === null ? [] : [{ content: '', done: false, toolUse }];
}

function finalizeToolUse(block: AnthropicToolBlock): ToolUseEvent | null {
  const raw = block.partialJson.length === 0 ? '{}' : block.partialJson;
  try {
    const input: unknown = JSON.parse(raw);
    if (!isRecord(input)) {
      return null;
    }
    return { id: block.id, name: block.name, input };
  } catch {
    return null;
  }
}

function handleMessageDelta(
  event: Record<string, unknown>,
  state: AnthropicStreamState,
): void {
  const delta = getRecord(event, 'delta');
  if (delta === undefined) {
    return;
  }
  state.setStopReason(getString(delta, 'stop_reason'));
}

function normalizeAnthropicStopReason(raw: string | undefined): StopReason | undefined {
  switch (raw) {
    case 'end_turn':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'length';
    case 'stop_sequence':
      return 'stop';
    case undefined:
      return undefined;
    default:
      return 'other';
  }
}
