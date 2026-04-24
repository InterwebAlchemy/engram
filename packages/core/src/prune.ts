import { MemoryState } from './types.js';
import type { Message, ChatMessage, PruneOptions } from './types.js';
import { ContextBuilder } from './context.js';

const DEFAULT_CORRECTION_FACTOR = 1;
const UNLIMITED_MESSAGE_CAP = 0;

function hasNonEmptyString(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

function estimateMessageTokens(
  estimator: ContextBuilder,
  content: string,
  maxTokens: number | undefined,
): number {
  return maxTokens === undefined ? 0 : estimator.estimateTokens(content);
}

function fitsWithinTokenBudget(
  tokensUsed: number,
  messageTokens: number,
  maxTokens: number | undefined,
): boolean {
  return maxTokens === undefined || tokensUsed + messageTokens <= maxTokens;
}

function appendWithinBudget(
  options: {
    included: Message[];
    candidates: Message[];
    estimator: ContextBuilder;
    maxMessages: number | undefined;
    maxTokens: number | undefined;
    initialTokensUsed: number;
  },
): {
  included: Message[];
  tokensUsed: number;
} {
  const {
    included,
    candidates,
    estimator,
    maxMessages,
    maxTokens,
    initialTokensUsed,
  } = options;
  let nonCoreCount = 0;
  let tokensUsed = initialTokensUsed;

  for (const message of candidates) {
    if (maxMessages !== undefined && nonCoreCount >= maxMessages) break;

    const messageTokens = estimateMessageTokens(estimator, message.content, maxTokens);
    if (!fitsWithinTokenBudget(tokensUsed, messageTokens, maxTokens)) continue;

    included.push(message);
    tokensUsed += messageTokens;
    nonCoreCount += 1;
  }

  return { included, tokensUsed };
}

function normalizeMaxMessages(maxMessages: number | undefined): number | undefined {
  return maxMessages === undefined || maxMessages === UNLIMITED_MESSAGE_CAP
    ? undefined
    : maxMessages;
}

function countInitialTokens(
  estimator: ContextBuilder,
  coreMessages: Message[],
  maxTokens: number | undefined,
  systemPrompt: string | undefined,
): number {
  let tokensUsed = 0;

  if (hasNonEmptyString(systemPrompt) && maxTokens !== undefined) {
    tokensUsed += estimator.estimateTokens(systemPrompt);
  }

  if (maxTokens === undefined) {
    return tokensUsed;
  }

  for (const message of coreMessages) {
    tokensUsed += estimator.estimateTokens(message.content);
  }

  return tokensUsed;
}

/**
 * Prune a message array down to what fits in a context window, respecting
 * memory states and optional caps.
 *
 * Priority order (mirrors the original obsidian-ai-research-assistant):
 *   1. Core — always included, exempt from maxMessages cap
 *   2. Remembered — included next, counts toward maxMessages
 *   3. Default — newest-first until maxMessages or maxTokens exhausted
 *   4. Forgotten — never included
 *
 * Returns a provider-agnostic `ChatMessage[]` (role + content) ready to send
 * to any OpenAI-compatible or Anthropic chat completion endpoint. If a
 * `systemPrompt` is provided it is prepended as the first message and its
 * tokens count against the budget.
 *
 * @example
 * ```ts
 * import { pruneMessages, MemoryState } from '@interwebalchemy/engram-core';
 *
 * const messages = [
 *   { role: 'user', content: 'Hi', memoryState: MemoryState.Default, timestamp: new Date() },
 *   { role: 'assistant', content: 'Hello!', memoryState: MemoryState.Default, timestamp: new Date() },
 * ];
 *
 * const apiMessages = pruneMessages(messages, {
 *   maxTokens: 4096,
 *   maxMessages: 10,
 *   systemPrompt: 'You are a helpful assistant.',
 * });
 * // → [{ role: 'system', content: '...' }, { role: 'user', content: 'Hi' }, ...]
 * ```
 */
export function pruneMessages(
  messages: Message[],
  options: PruneOptions = {},
): ChatMessage[] {
  const {
    maxTokens,
    systemPrompt,
    correctionFactor = DEFAULT_CORRECTION_FACTOR,
  } = options;

  // 0 is treated as "no limit" — undefined and 0 both mean unlimited.
  const maxMessages = normalizeMaxMessages(options.maxMessages);

  const estimator = new ContextBuilder(correctionFactor);

  // ─── Partition by memory state ──────────────────────────────────────────

  const core = messages.filter((m) => m.memoryState === MemoryState.Core);
  const remembered = messages.filter((m) => m.memoryState === MemoryState.Remembered);
  const defaults = messages.filter((m) => m.memoryState === MemoryState.Default);
  // Forgotten messages are silently dropped

  // ─── Budget accounting ──────────────────────────────────────────────────

  const tokensUsed = countInitialTokens(estimator, core, maxTokens, systemPrompt);

  // ─── Fill with remembered, then defaults ────────────────────────────────

  const included: Message[] = [...core];
  const { tokensUsed: rememberedTokensUsed } = appendWithinBudget({
    included,
    candidates: remembered,
    estimator,
    maxMessages,
    maxTokens,
    initialTokensUsed: tokensUsed,
  });

  // Defaults: newest-first (reverse-chronological) to keep recent context
  appendWithinBudget({
    included,
    candidates: [...defaults].reverse(),
    estimator,
    maxMessages,
    maxTokens,
    initialTokensUsed: rememberedTokensUsed,
  });

  // ─── Always include the most recent message ───────────────────────────────
  // Regardless of budget or caps, the latest non-forgotten message (the user's
  // current turn) must always be present — sending nothing to the provider
  // makes no sense.

  const lastNonForgotten = [...messages]
    .reverse()
    .find((m) => m.memoryState !== MemoryState.Forgotten);
  if (lastNonForgotten !== undefined && !included.includes(lastNonForgotten)) {
    included.push(lastNonForgotten);
  }

  // ─── Restore chronological order ────────────────────────────────────────

  included.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // ─── Map to ChatMessage[] ───────────────────────────────────────────────

  const out: ChatMessage[] = [];
  if (hasNonEmptyString(systemPrompt)) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const msg of included) {
    out.push({ role: msg.role, content: msg.content });
  }

  return out;
}
