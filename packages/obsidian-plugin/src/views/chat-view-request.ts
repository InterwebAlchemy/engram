import {
  MemoryState,
  TOOLS,
  type Message,
} from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import type { CompletionConfig, ToolDefinition } from '../providers/types';
import {
  buildMemoryLabel,
  composeSystemPrompt,
  MEMORY_CONTEXT_TOKEN_MULTIPLIER,
} from './chat-view-helpers';

export interface ConversationOverrides {
  readonly maxTokens: string;
  readonly systemPrompt: string;
  readonly temperature: string;
}

export interface CompletionRequest {
  readonly completionConfig: CompletionConfig;
  readonly settings: EngramPlugin['settings'];
  readonly systemPrompt: string | undefined;
}

export function createUserMessage(content: string): Message {
  return {
    role: 'user',
    content,
    timestamp: new Date(),
    memoryState: MemoryState.Default,
  };
}

export async function createCompletionRequest(options: {
  readonly bootstrap: string | undefined;
  readonly overrides: ConversationOverrides;
  readonly plugin: EngramPlugin;
  readonly selectedModel: string;
  readonly text: string;
}): Promise<CompletionRequest> {
  const {
    bootstrap,
    overrides,
    plugin,
    selectedModel,
    text,
  } = options;
  const { settings } = plugin;
  const maxTokens = overrides.maxTokens === ''
    ? settings.maxTokens
    : parseInt(overrides.maxTokens, 10);
  const memoryBlock = await loadMemoryBlock(plugin, text, maxTokens);
  const trimmedSystemPrompt = overrides.systemPrompt.trim();
  const basePrompt = resolveBasePrompt(trimmedSystemPrompt, bootstrap, settings.defaultPreamble);

  return {
    completionConfig: {
      model: selectedModel,
      temperature: overrides.temperature === ''
        ? settings.temperature
        : parseFloat(overrides.temperature),
      maxTokens,
      tools: settings.toolCallingEnabled ? engramTools() : undefined,
    },
    settings,
    systemPrompt: composeSystemPrompt(basePrompt, memoryBlock),
  };
}

function engramTools(): ToolDefinition[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Record<string, unknown>,
  }));
}

function resolveBasePrompt(
  userOverride: string,
  bootstrap: string | undefined,
  defaultPreamble: string,
): string {
  if (userOverride.length > 0) {
    return userOverride;
  }
  if (bootstrap !== undefined && bootstrap.length > 0) {
    return bootstrap;
  }
  return defaultPreamble;
}

async function loadMemoryBlock(
  plugin: EngramPlugin,
  text: string,
  maxTokens: number,
): Promise<string> {
  try {
    const sections = await plugin.memoryManager.getContext(
      text,
      { max: maxTokens * MEMORY_CONTEXT_TOKEN_MULTIPLIER },
    );
    return sections
      .sort((a, b) => b.priority - a.priority)
      .map(({ label, content }) => `### ${buildMemoryLabel(label)}\n\n${content.trim()}`)
      .join('\n\n---\n\n');
  } catch {
    return '';
  }
}
