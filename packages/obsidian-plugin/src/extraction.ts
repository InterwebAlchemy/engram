import {
  type MemoryManager,
  type Conversation,
  MemoryType,
  type VaultNote,
  type ChatMessage,
  type Confidence,
} from '@interwebalchemy/engram-core';
import type { ProviderAdapter, CompletionConfig } from './providers/types';

interface ExtractedMemory {
  content: string;
  type: 'fact' | 'entity' | 'reflection';
  tags: string[];
  confidence: Confidence;
}

const EXTRACTION_PROMPT = `Based on this conversation, identify any facts, user preferences, important entities, or reflections worth remembering long-term.

Return a JSON array (no markdown fences, no explanation):
[{ "content": "...", "type": "fact|entity|reflection", "tags": ["..."], "confidence": "high|medium|low" }]

Rules:
- Only include genuinely useful, non-obvious information.
- Facts are concrete data points (preferences, configurations, names, dates).
- Entities are people, projects, tools, or concepts that come up repeatedly.
- Reflections are insights, lessons learned, or meta-observations.
- If nothing is worth remembering, return an empty array: []`;

/**
 * Run a background extraction pass after an assistant response.
 * Sends the recent conversation context to the same provider and asks it
 * to identify facts, entities, and reflections worth persisting.
 */
export async function extractMemories(
  conversation: Conversation,
  memoryManager: MemoryManager,
  provider: ProviderAdapter,
  config: CompletionConfig,
): Promise<VaultNote[]> {
  // Build a compact context for the extraction call
  const contextMessages = conversation.toChatMessages({
    maxMessages: 20,
    maxTokens: 8000,
  });

  // Append the extraction instruction as a user message
  const messagesForExtraction: ChatMessage[] = [
    ...contextMessages,
    { role: 'user', content: EXTRACTION_PROMPT },
  ];

  const result = await provider.complete(messagesForExtraction, {
    ...config,
    temperature: 0,
  });

  // Parse the JSON response
  const extracted = parseExtractedMemories(result.content);
  if (extracted.length === 0) {
    return [];
  }

  // Store each extracted memory
  const typeMap: Record<ExtractedMemory['type'], MemoryType> = {
    fact: MemoryType.Fact,
    entity: MemoryType.Entity,
    reflection: MemoryType.Reflection,
  };

  return (await Promise.all(extracted.map(async (memory) => {
    try {
      return await memoryManager.store(
        memory.content,
        typeMap[memory.type],
        {
          tags: memory.tags,
          provider: provider.id,
          confidence: memory.confidence,
        },
      );
    } catch {
      return null;
    }
  }))).filter((note): note is VaultNote => note !== null);
}

function parseExtractedMemories(rawContent: string): ExtractedMemory[] {
  try {
    const cleanedContent = stripMarkdownFences(rawContent);
    const parsed: unknown = JSON.parse(cleanedContent);
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is ExtractedMemory => isExtractedMemory(item));
  } catch {
    return [];
  }
}

function stripMarkdownFences(content: string): string {
  return content
    .replace(/^```json?\s*/iv, '')
    .replace(/```\s*$/v, '')
    .trim();
}

function isExtractedMemory(value: unknown): value is ExtractedMemory {
  if (!isRecord(value)) {
    return false;
  }

  const { content, type, tags, confidence } = value;
  return (
    isExtractedContent(content) &&
    isExtractedType(type) &&
    isStringArray(tags) &&
    isConfidence(confidence)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isExtractedContent(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isExtractedType(value: unknown): value is ExtractedMemory['type'] {
  return value === 'fact' || value === 'entity' || value === 'reflection';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isConfidence(value: unknown): value is Confidence {
  return value === 'high' || value === 'medium' || value === 'low';
}
