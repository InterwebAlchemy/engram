import type { ChatMessage } from '@interwebalchemy/engram-core';

// ─── Tool result blocks ──────────────────────────────────────────────────────

export interface ToolResultBlock {
  toolUseId: string;
  content: string;
  isError?: boolean;
}

/**
 * Chat history entry that may carry tool_use/tool_result payloads for the
 * provider tool-calling loop. Adapters translate these into provider-specific
 * wire formats (Anthropic content-block arrays, OpenAI `tool_calls` +
 * `role: 'tool'` messages).
 */
export interface ExtendedChatMessage extends ChatMessage {
  toolUses?: ToolUseEvent[];
  toolResults?: ToolResultBlock[];
}

// ─── Model ───────────────────────────────────────────────────────────────────

export interface Model {
  id: string;
  name: string;
  contextWindow?: number;
}

// ─── Provider Configuration ──────────────────────────────────────────────────

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl?: string;
  apiKey?: string;
  defaultModel?: string;
}

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * Provider-agnostic tool definition. Matches the Anthropic shape; the OpenAI
 * adapter translates to `{type: 'function', function: {...}}` on request.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * A complete tool call emitted by the model during streaming. Adapters buffer
 * partial JSON deltas internally and only yield this event once the call has
 * terminated with well-formed input.
 */
export interface ToolUseEvent {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type StopReason = 'end_turn' | 'tool_use' | 'stop' | 'length' | 'other';

// ─── Completion ──────────────────────────────────────────────────────────────

export interface CompletionConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  tools?: ToolDefinition[];
}

export interface CompletionResult {
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  metadata?: Record<string, unknown>;
}

export interface StreamChunk {
  content: string;
  done: boolean;
  /** Reasoning / thinking tokens emitted before the main response. */
  reasoning?: string;
  /** A fully-assembled tool call the model wants to execute. */
  toolUse?: ToolUseEvent;
  /** Why the stream ended; present on the terminal chunk. */
  stopReason?: StopReason;
}

// ─── Provider Adapter ────────────────────────────────────────────────────────

export interface ProviderAdapter {
  id: string;
  name: string;
  updateConfig?: (config: Partial<ProviderConfig>) => void;

  /** Non-streaming completion. */
  complete: (
    messages: ChatMessage[],
    config: CompletionConfig,
  ) => Promise<CompletionResult>;

  /** Streaming completion. Yields partial content chunks. */
  stream: (
    messages: ExtendedChatMessage[],
    config: CompletionConfig,
    signal?: AbortSignal,
  ) => AsyncIterable<StreamChunk>;

  /** Fetch available models from the provider. */
  listModels: () => Promise<Model[]>;
}
