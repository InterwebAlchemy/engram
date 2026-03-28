// Public API for @interwebalchemy/engram-core

export { MemoryState, MemoryType, defaultMemoryConfig, SOUL_DOCUMENT_SLUG } from './types';
export type {
  NoteFrontmatter,
  ConversationFrontmatter,
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
} from './types';

export { VaultNote } from './vault';
export { MemoryManager } from './memory';
export { MemoryStateManager } from './memory-state';
export { ContextBuilder } from './context';
export { Conversation } from './conversation';

export type { FileSystemAdapter } from './adapters/types';
export { NodeAdapter } from './adapters/node';

export { pruneMessages } from './prune';
export { slugify, datePath } from './utils';
