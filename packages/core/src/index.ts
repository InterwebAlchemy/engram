// Public API for @interwebalchemy/engram-core

export { MemoryState, MemoryType, ThreadStatus, defaultMemoryConfig, SOUL_DOCUMENT_SLUG } from './types';
export type {
  NoteFrontmatter,
  ConversationFrontmatter,
  ThreadFrontmatter,
  ThreadFields,
  Message,
  ChatMessage,
  TokenBudget,
  PruneOptions,
  ContextSection,
  MemoryConfig,
  MemoryFilters,
  SearchResult,
  Confidence,
  NoteStatus,
  ScratchEntry,
  ScratchReadOptions,
  ScratchCompactOptions,
  ScratchDeleteOptions,
} from './types';

export { VaultNote } from './vault';
export { MemoryManager } from './memory';
export { MemoryStateManager } from './memory-state';
export { ContextBuilder } from './context';
export { Conversation } from './conversation';

export type { FileSystemAdapter } from './adapters/types';
export { NodeAdapter } from './adapters/node';

export { pruneMessages } from './prune';
export { slugify, datePath, tokenizeQuery } from './utils';

export { KeywordSearchProvider } from './scoring';
export type { SearchProvider, ScoredNote } from './scoring';

export {
  TOOLS,
  SESSION_ID,
  buildCheckpointReminder,
  CONFIDENCE_VALUES,
  BOOTSTRAP_STATES,
  MEMORY_TYPES,
  MEMORY_STATES,
  THREAD_STATUSES,
  MEMORY_TYPE_MAP,
  MEMORY_STATE_MAP,
  THREAD_STATUS_MAP,
  executeToolCall,
  extractText,
  getToolHandler,
} from './tools';
export type {
  ToolArgs,
  ToolMessage,
  ToolResponse,
  ToolName,
} from './tools';
