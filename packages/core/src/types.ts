// ─── Soul Document ────────────────────────────────────────────────────────────

/**
 * Reserved slug for the soul document — a Core reflection note where the
 * assistant records its values, character, and sense of self. Lives at
 * engram/memory/reflection/soul.md and is always loaded first in context,
 * before other Core memories.
 */
export const SOUL_DOCUMENT_SLUG = 'soul';

// ─── Memory States ────────────────────────────────────────────────────────────

export enum MemoryState {
  /** Always included in context. Survives across conversations. */
  Core = 'core',
  /** Prioritized for inclusion. Subject to token budget. */
  Remembered = 'remembered',
  /** Default. Included in FIFO order when space allows. */
  Default = 'default',
  /** Never included in context. Still in the vault, just ignored. */
  Forgotten = 'forgotten',
}

// ─── Memory Types ─────────────────────────────────────────────────────────────

export enum MemoryType {
  Fact = 'fact',
  Entity = 'entity',
  Reflection = 'reflection',
  Conversation = 'conversation',
  Working = 'working',
  /** Persistent procedural knowledge — how to do things. Retrieved by slug, not search. */
  Skill = 'skill',
  /** Ephemeral workspace. Not injected into context. Cleared manually or by consolidation. */
  Scratch = 'scratch',
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';
export type NoteStatus = 'active' | 'archived';

/**
 * How much context the author had when writing this memory.
 * - full: soul + episodic context loaded (normal gl1tch session)
 * - partial: soul loaded, episodic context missing
 * - none: no bootstrap — raw model with no identity context
 */
export type BootstrapState = 'full' | 'partial' | 'none';

export interface NoteFrontmatter {
  type: MemoryType | string;
  created: string;       // ISO 8601
  updated: string;       // ISO 8601
  provider?: string;
  tags?: string[];
  memory_state?: MemoryState;
  confidence?: Confidence;
  source?: string;       // Obsidian wikilink to origin conversation
  status?: NoteStatus;
  /** Epistemic quality: how much context the author had when writing this memory. */
  bootstrap_state?: BootstrapState;
  /** Who authored this memory (e.g. 'gl1tch', 'claude'). */
  agent?: string;
  /** Platform where this memory was written (e.g. 'claude-code', 'claude-ai', 'claude-desktop'). */
  platform?: string;
  /**
   * Compressed summary for token-efficient context loading. When present, get_context
   * uses this for lower-priority memories (p50/p70) instead of full content. Full text
   * is always available via memory_read. Soul and core memories (p100/p90) always load
   * full content regardless.
   */
  summary?: string;
  [key: string]: unknown;
}

export interface ConversationFrontmatter {
  type: 'conversation';
  created: string;
  updated: string;
  providers: string[];
  tags?: string[];
  summary?: string;
  message_count: number;
  [key: string]: unknown;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  provider?: string;
  model?: string;
  memoryState: MemoryState;
  metadata?: Record<string, unknown>;
}

// ─── Context ─────────────────────────────────────────────────────────────────

export interface TokenBudget {
  max: number;
  used?: number;
}

export interface ContextSection {
  label: string;
  content: string;
  priority: number;
}

// ─── Memory Config ────────────────────────────────────────────────────────────

export interface MemoryConfig {
  basePath: string;
  mode: 'integrated' | 'standalone';
  engramRoot: string;
  memoryPath: string;
  conversationsPath: string;
  workingPath: string;
  scratchPath: string;
  archivePath: string;
  readPaths: string[];
  tokenCorrections: Record<string, number>;
}

export function defaultMemoryConfig(
  basePath: string,
  mode: 'integrated' | 'standalone' = 'integrated',
): MemoryConfig {
  return {
    basePath,
    mode,
    engramRoot: mode === 'integrated' ? 'engram' : '.',
    memoryPath: 'memory',
    conversationsPath: 'conversations',
    workingPath: 'working',
    scratchPath: 'scratch',
    archivePath: 'archive',
    readPaths: [],
    tokenCorrections: {},
  };
}

// ─── Chat Messages (provider-agnostic output) ────────────────────────────────

/** Minimal message shape compatible with OpenAI-style chat completion endpoints. */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Options for pruning a message list down to what fits in a context window.
 * Pass to `pruneMessages()` or `Conversation.toChatMessages()`.
 */
export interface PruneOptions {
  /** Maximum token budget for the returned messages (estimated via gpt-tokenizer). */
  maxTokens?: number;
  /**
   * Maximum number of non-core messages to include (matches the original plugin's
   * maxMemoryCount setting). Core messages are always included regardless of this cap.
   */
  maxMessages?: number;
  /** System prompt to prepend. If provided, its tokens count against the budget. */
  systemPrompt?: string;
  /** Token estimator correction factor (default 1.0). */
  correctionFactor?: number;
}

// ─── Search ───────────────────────────────────────────────────────────────────

export interface SearchResult {
  path: string;
  content: string;
  score?: number;
}

// ─── Memory Filters ───────────────────────────────────────────────────────────

export interface MemoryFilters {
  type?: MemoryType;
  state?: MemoryState;
  tags?: string[];
  limit?: number;
  since?: Date;
  bootstrap_state?: BootstrapState;
  agent?: string;
  platform?: string;
}
