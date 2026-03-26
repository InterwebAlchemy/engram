import type { ChatMessage } from '@interwebalchemy/engram-core';

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

// ─── Completion ──────────────────────────────────────────────────────────────

export interface CompletionConfig {
  model: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
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
}

// ─── Provider Adapter ────────────────────────────────────────────────────────

export interface ProviderAdapter {
  id: string;
  name: string;

  /** Non-streaming completion. */
  complete(
    messages: ChatMessage[],
    config: CompletionConfig,
  ): Promise<CompletionResult>;

  /** Streaming completion. Yields partial content chunks. */
  stream(
    messages: ChatMessage[],
    config: CompletionConfig,
    signal?: AbortSignal,
  ): AsyncIterable<StreamChunk>;

  /** Fetch available models from the provider. */
  listModels(): Promise<Model[]>;
}
