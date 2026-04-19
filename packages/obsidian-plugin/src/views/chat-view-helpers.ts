import {
  MemoryState,
  type Message,
} from '@interwebalchemy/engram-core';
import { KNOWN_MODELS } from '../constants';

export const CHAT_VIEW_TITLE = 'Chat';
export const CHAT_VIEW_ICON = 'brain-circuit';
export const THINKING_LABEL = 'Thinking...';
export const MEMORY_CONTEXT_TOKEN_FALLBACK = 8192;
export const MEMORY_CONTEXT_TOKEN_MULTIPLIER = 3;
const THINK_OPEN_PATTERN = /^[\s\S]*?<think(?:ing)?>[ \t]*/iu;
const THINK_CLOSE_PATTERN = /^(?<reasoning>[\s\S]*?)<\/think(?:ing)?>[ \t]*/iu;
const MEMORY_LABEL_PATTERN = /^memory:.*[\\/]/u;
const MARKDOWN_SUFFIX_PATTERN = /\.md$/u;

export function parseThinkContent(raw: string): { content: string; reasoning: string } {
  const openMatch = THINK_OPEN_PATTERN.exec(raw);
  if (openMatch === null) {
    return { content: raw, reasoning: '' };
  }

  const afterOpen = raw.slice(openMatch[0].length);
  const closeMatch = THINK_CLOSE_PATTERN.exec(afterOpen);
  if (closeMatch === null) {
    return { content: '', reasoning: afterOpen };
  }

  const { reasoning = '' } = closeMatch.groups ?? {};
  return {
    content: afterOpen.slice(closeMatch[0].length).trimStart(),
    reasoning: reasoning.trim(),
  };
}

export function getModelDisplayName(providerId: string, modelId: string): string {
  const knownModels = KNOWN_MODELS[providerId] ?? [];
  return knownModels.find((model) => model.id === modelId)?.name ?? modelId;
}

export function getRoleLabel(message: Message): string {
  if (message.role === 'system') {
    return 'System';
  }
  if (message.role !== 'assistant') {
    return 'You';
  }

  return message.model === undefined
    ? 'Assistant'
    : `Assistant [${message.model}]`;
}

export function getReasoning(metadata: Record<string, unknown> | undefined): string | undefined {
  const reasoning = metadata?.reasoning;
  return typeof reasoning === 'string' && reasoning.length > 0
    ? reasoning
    : undefined;
}

export function parseProviderModelValue(value: string): {
  providerId: string;
  modelId: string;
} {
  const [providerId = '', modelId = ''] = value.split('::');
  return { providerId, modelId };
}

export function buildMemoryLabel(label: string): string {
  if (label === 'soul-document') {
    return 'Soul';
  }

  return label.replace(MEMORY_LABEL_PATTERN, '').replace(MARKDOWN_SUFFIX_PATTERN, '');
}

export function composeSystemPrompt(
  basePrompt: string,
  memoryBlock: string,
): string | undefined {
  if (memoryBlock.length === 0) {
    return basePrompt.length === 0 ? undefined : basePrompt;
  }
  if (basePrompt.length === 0) {
    return `## Memories\n\n${memoryBlock}`;
  }

  return `${basePrompt}\n\n## Memories\n\n${memoryBlock}`;
}

export function nextMemoryState(current: MemoryState): MemoryState {
  switch (current) {
    case MemoryState.Default:
      return MemoryState.Core;
    case MemoryState.Core:
      return MemoryState.Remembered;
    case MemoryState.Remembered:
      return MemoryState.Forgotten;
    case MemoryState.Forgotten:
      return MemoryState.Default;
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
