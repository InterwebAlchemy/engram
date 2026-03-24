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
}

// ─── Frontmatter ─────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';
export type NoteStatus = 'active' | 'archived';

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
}
