// Public API for @interwebalchemy/engram-core

export { MemoryState, MemoryType, ThreadStatus, defaultMemoryConfig, SOUL_DOCUMENT_SLUG } from './types.js';
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
} from './types.js';

export { VaultNote } from './vault.js';
export { MemoryManager } from './memory.js';
export type {
  ResolvedThread,
  ResolvedThreadCandidate,
} from './thread-operations.js';
export { detectGitRemote, normalizeRemoteUrl } from './git-remote.js';
export type { GitRemoteDetector } from './git-remote.js';
export { MemoryStateManager } from './memory-state.js';
export { ContextBuilder } from './context.js';
export { Conversation } from './conversation.js';
export { estimateTokens } from './tokenizer.js';
export {
  BOOTSTRAP_ENTRY_MAX_CHARS,
  formatBootstrapScratchEntry,
  renderBootstrapScratch,
  findCompleteDreamSequences,
  countPendingDreams,
  extractFirstPendingDream,
} from './scratch-helpers.js';
export type {
  BootstrapScratchRendered,
  RenderBootstrapScratchOptions,
  RenderBootstrapScratchResult,
  PendingDream,
} from './scratch-helpers.js';

export type { FileSystemAdapter } from './adapters/types.js';
export { NodeAdapter } from './adapters/node.js';

export { pruneMessages } from './prune.js';
export { slugify, datePath, tokenizeQuery } from './utils.js';

export { KeywordSearchProvider } from './scoring.js';
export type { SearchProvider, ScoredNote } from './scoring.js';

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
} from './tools/index.js';
export type {
  ToolArgs,
  ToolMessage,
  ToolResponse,
  ToolName,
} from './tools/index.js';
