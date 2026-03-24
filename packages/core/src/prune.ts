import { MemoryState } from './types';
import type { Message, ChatMessage, PruneOptions } from './types';
import { ContextBuilder } from './context';

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
    maxMessages,
    systemPrompt,
    correctionFactor = 1.0,
  } = options;

  const estimator = new ContextBuilder(correctionFactor);

  // ─── Partition by memory state ──────────────────────────────────────────

  const core = messages.filter((m) => m.memoryState === MemoryState.Core);
  const remembered = messages.filter((m) => m.memoryState === MemoryState.Remembered);
  const defaults = messages.filter((m) => m.memoryState === MemoryState.Default);
  // Forgotten messages are silently dropped

  // ─── Budget accounting ──────────────────────────────────────────────────

  let tokensUsed = 0;
  if (systemPrompt && maxTokens) {
    tokensUsed += estimator.estimateTokens(systemPrompt);
  }

  // Core always included — count their tokens but never skip them
  for (const msg of core) {
    if (maxTokens) {
      tokensUsed += estimator.estimateTokens(msg.content);
    }
  }

  // ─── Fill with remembered, then defaults ────────────────────────────────

  let nonCoreCount = 0;
  const included: Message[] = [...core];

  for (const msg of remembered) {
    if (maxMessages !== undefined && nonCoreCount >= maxMessages) break;
    const tokens = maxTokens ? estimator.estimateTokens(msg.content) : 0;
    if (maxTokens && tokensUsed + tokens > maxTokens) continue;
    included.push(msg);
    tokensUsed += tokens;
    nonCoreCount++;
  }

  // Defaults: newest-first (reverse-chronological) to keep recent context
  for (const msg of [...defaults].reverse()) {
    if (maxMessages !== undefined && nonCoreCount >= maxMessages) break;
    const tokens = maxTokens ? estimator.estimateTokens(msg.content) : 0;
    if (maxTokens && tokensUsed + tokens > maxTokens) continue;
    included.push(msg);
    tokensUsed += tokens;
    nonCoreCount++;
  }

  // ─── Restore chronological order ────────────────────────────────────────

  included.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // ─── Map to ChatMessage[] ───────────────────────────────────────────────

  const out: ChatMessage[] = [];
  if (systemPrompt) {
    out.push({ role: 'system', content: systemPrompt });
  }
  for (const msg of included) {
    out.push({ role: msg.role, content: msg.content });
  }

  return out;
}
