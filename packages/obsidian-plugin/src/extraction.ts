import {
  MemoryManager,
  Conversation,
  MemoryType,
  pruneMessages,
} from '@interwebalchemy/engram-core';
import type { Message, VaultNote, ChatMessage, Confidence } from '@interwebalchemy/engram-core';
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
  let extracted: ExtractedMemory[];
  try {
    // Strip markdown fences if the model wrapped them anyway
    const cleaned = result.content
      .replace(/^```json?\s*/i, '')
      .replace(/```\s*$/, '')
      .trim();
    extracted = JSON.parse(cleaned);
    if (!Array.isArray(extracted)) return [];
  } catch {
    return [];
  }

  // Store each extracted memory
  const typeMap: Record<string, MemoryType> = {
    fact: MemoryType.Fact,
    entity: MemoryType.Entity,
    reflection: MemoryType.Reflection,
  };

  const notes: VaultNote[] = [];
  for (const mem of extracted) {
    if (!mem.content || !mem.type) continue;
    try {
      const note = await memoryManager.store(
        mem.content,
        typeMap[mem.type] ?? MemoryType.Fact,
        mem.tags ?? [],
        provider.id,
        mem.confidence,
      );
      notes.push(note);
    } catch {
      // Skip individual failures (e.g. duplicate slugs)
    }
  }

  return notes;
}
