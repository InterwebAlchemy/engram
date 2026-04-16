import { randomUUID } from 'node:crypto';
import {
  MemoryState,
  MemoryType,
  ThreadStatus,
} from '@interwebalchemy/engram-core';

interface ArraySchemaProperty {
  description: string;
  items: { type: 'string' };
  type: 'array';
}

interface BooleanSchemaProperty {
  description: string;
  type: 'boolean';
}

interface NumberSchemaProperty {
  description: string;
  type: 'number';
}

interface StringSchemaProperty {
  description: string;
  enum?: string[];
  type: 'string';
}

export const SESSION_ID = randomUUID();
export const JSON_INDENT = 2;
export const SHORT_PREVIEW_LENGTH = 120;
export const LONG_PREVIEW_LENGTH = 200;
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 2000;
export const DEFAULT_LIST_LIMIT = 20;
export const DEFAULT_SEARCH_LIMIT = 10;
export const DEFAULT_SCRATCH_THRESHOLD_HOURS = 1;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
export const MILLISECONDS_PER_MINUTE = SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;
export const MILLISECONDS_PER_HOUR = MINUTES_PER_HOUR * MILLISECONDS_PER_MINUTE;
export const MILLISECONDS_PER_DAY = MINUTES_PER_HOUR * MILLISECONDS_PER_HOUR;
export const MARKDOWN_SUFFIX_PATTERN = /\.md$/u;

export const CONFIDENCE_VALUES = ['high', 'medium', 'low'] as const;
export const BOOTSTRAP_STATES = ['full', 'partial', 'none'] as const;
export const MEMORY_TYPES = ['fact', 'entity', 'reflection'] as const;
export const MEMORY_STATES = ['core', 'remembered', 'default', 'forgotten'] as const;
export const THREAD_STATUSES = ['active', 'paused', 'closed'] as const;

export const MEMORY_TYPE_MAP: Record<(typeof MEMORY_TYPES)[number], MemoryType> = {
  fact: MemoryType.Fact,
  entity: MemoryType.Entity,
  reflection: MemoryType.Reflection,
};

export const MEMORY_STATE_MAP: Record<(typeof MEMORY_STATES)[number], MemoryState> = {
  core: MemoryState.Core,
  remembered: MemoryState.Remembered,
  default: MemoryState.Default,
  forgotten: MemoryState.Forgotten,
};

export const THREAD_STATUS_MAP: Record<(typeof THREAD_STATUSES)[number], ThreadStatus> = {
  active: ThreadStatus.Active,
  paused: ThreadStatus.Paused,
  closed: ThreadStatus.Closed,
};

const stringProp = (description: string): StringSchemaProperty => ({ type: 'string', description });
const numberProp = (description: string): NumberSchemaProperty => ({ type: 'number', description });
const booleanProp = (description: string): BooleanSchemaProperty => ({ type: 'boolean', description });
const enumProp = (values: readonly string[], description: string): StringSchemaProperty => ({
  type: 'string',
  enum: [...values],
  description,
});
const stringArrayProp = (description: string): ArraySchemaProperty => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

export const TOOLS = [
  {
    name: 'memory',
    description:
      'Manage vault memories. Actions: store, read, update, search, list, archive.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(
          ['store', 'read', 'update', 'search', 'list', 'archive'] as const,
          'Memory action to perform.',
        ),
        path: stringProp('Path to the memory note. Used by `read` and `update`.'),
        content: stringProp('Memory content. Used by `store` and optional for `update`.'),
        type: enumProp(MEMORY_TYPES, 'Memory type filter or category.'),
        tags: stringArrayProp('Obsidian-compatible tags for this memory.'),
        confidence: enumProp(CONFIDENCE_VALUES, 'Confidence level for facts.'),
        state: enumProp(
          MEMORY_STATES,
          'Memory state controlling retrieval priority: core, remembered, default, or forgotten.',
        ),
        limit: numberProp('Maximum number of results to return.'),
        query: stringProp('Search query for `search`.'),
        bootstrap_state: enumProp(
          BOOTSTRAP_STATES,
          'Epistemic quality: how much context the author had when writing this memory.',
        ),
        agent: stringProp('Filter or author tag for the writing agent.'),
        platform: stringProp('Filter or author tag for the writing platform.'),
        session_id: stringProp(
          'Session UUID from `soul` or `context` for multi-instance attribution.',
        ),
        summary: stringProp(
          'Short bullet summary used by `context` for non-core memory loading.',
        ),
        thread: stringProp(
          'Thread ID for thread-scoped memories. Omit for cross-thread memories.',
        ),
        older_than_days: numberProp(
          'Used by `archive` to restrict archival to older forgotten memories.',
        ),
      },
      required: ['action'],
    },
  },
  {
    name: 'soul',
    description:
      'Manage the Soul document. Actions: get, set.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['get', 'set'] as const, 'Soul action to perform.'),
        content: stringProp('Full Soul document content. Required for `set`.'),
      },
      required: ['action'],
    },
  },
  {
    name: 'context',
    description:
      'Load scoped session context for a query.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['load'] as const, 'Context action to perform.'),
        query: stringProp(
          'Describe the current task or session focus. Used to surface relevant memories.',
        ),
        token_budget: numberProp(
          'Memory allocation budget in tokens (default 2000). Core and thread summaries load first.',
        ),
        thread_id: stringProp(
          'Active thread ID. Thread-scoped memories from other threads are excluded.',
        ),
      },
      required: ['action', 'query'],
    },
  },
  {
    name: 'note',
    description:
      'Manage working notes. Actions: create, read, update, append, list, search, delete.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(
          ['create', 'read', 'update', 'append', 'list', 'search', 'delete'] as const,
          'Note action to perform.',
        ),
        path: stringProp(
          'Path relative to engram/notes (for example "blog/session-21"). `.md` is added if omitted. For inbox items use "inbox/<name>" — a path of just "inbox" creates a file next to the directory and won\'t be picked up.',
        ),
        content: stringProp('Markdown content for `create`, `update`, or `append`.'),
        separator: stringProp('Optional separator used by `append`. Defaults to a blank line.'),
        expected_current_content: stringProp(
          'Optional optimistic-concurrency guard for `update` and `append`.',
        ),
        prefix: stringProp('Optional prefix filter for `list`.'),
        query: stringProp('Search query for `search`.'),
        limit: numberProp('Maximum number of results to return.'),
      },
      required: ['action'],
    },
  },
  {
    name: 'conversation',
    description: 'Store conversation transcripts. Actions: save.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['save'] as const, 'Conversation action to perform.'),
        messages: {
          type: 'array',
          description: 'Array of message objects.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant', 'system'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        summary: stringProp('One-line summary for the frontmatter.'),
        tags: stringArrayProp('Optional tags.'),
      },
      required: ['action', 'messages'],
    },
  },
  {
    name: 'skill',
    description: 'Manage reusable skills. Actions: store, get, list.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['store', 'get', 'list'] as const, 'Skill action to perform.'),
        slug: stringProp('URL-safe skill identifier.'),
        content: stringProp('Skill definition in markdown. Required for `store`.'),
        tags: stringArrayProp('Optional tags for `store`.'),
      },
      required: ['action'],
    },
  },
  {
    name: 'scratch',
    description: 'Manage the shared scratch log. Actions: append, read, compact, prune, delete, clear.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['append', 'read', 'compact', 'prune', 'delete', 'clear'] as const, 'Scratch action to perform.'),
        content: stringProp('Scratch content for `append`.'),
        session_id: stringProp(
          'Session UUID for `read` filtering, `compact` targeting, or `delete` filtering.',
        ),
        match_text: stringProp('Substring content filter for `delete`.'),
        limit: numberProp('Maximum number of scratch entries to return.'),
        since: stringProp('ISO 8601 timestamp filter for `read`.'),
        bootstrap: booleanProp('Apply bootstrap pruning and dream-sequence compaction for `read`.'),
        token_budget: numberProp('Approximate token limit for bootstrap `read`. Oldest entries are dropped to fit; individual entries are truncated at 400 chars. Default: unlimited.'),
        threshold_hours: numberProp('Age threshold in hours for `compact` or `delete`. Defaults to 1.'),
        compacted_content: stringProp('Replacement summary content for `compact`.'),
      },
      required: ['action'],
    },
  },
  {
    name: 'thread',
    description: 'Manage threads and thread todos. Actions: get, set, update, list, resolve, merge, todo_*.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(
          [
            'get',
            'set',
            'update',
            'list',
            'resolve',
            'merge',
            'todo_list',
            'todo_add',
            'todo_complete',
            'todo_reopen',
            'todo_remove',
          ] as const,
          'Thread action to perform.',
        ),
        thread_id: stringProp('Thread identifier slug.'),
        source_thread_id: stringProp('Source thread ID for `merge`.'),
        target_thread_id: stringProp('Target thread ID for `merge`.'),
        content: stringProp('Thread body markdown. Required for `set`, optional for `update`.'),
        name: stringProp('Human-readable thread name.'),
        description: stringProp('Brief thread description.'),
        status: enumProp(THREAD_STATUSES, 'Thread status.'),
        goals: stringArrayProp('Goals or deliverables for the thread.'),
        paths: stringArrayProp('Filesystem paths associated with the thread.'),
        related_threads: stringArrayProp('Related thread IDs.'),
        tags: stringArrayProp('Obsidian-compatible tags.'),
        cwd: stringProp('Working directory hint for `resolve`.'),
        git_remote: stringProp('Git remote hint for `resolve`.'),
        auto_create: booleanProp('Whether `resolve` may auto-create a missing thread.'),
        item: stringProp('Checklist item text for `todo_*` actions.'),
        include_completed: booleanProp('Whether `todo_list` should include completed items.'),
        prepend: booleanProp('Whether `todo_add` should insert at the top of the section.'),
      },
      required: ['action'],
    },
  },
  {
    name: 'inbox',
    description: 'Manage inbox items. Actions: list, add, read, remove.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(
          ['list', 'add', 'read', 'remove'] as const,
          'Inbox action to perform.',
        ),
        thread_id: stringProp('Thread ID to scope inbox items. Omit for global inbox.'),
        content: stringProp('Item content for `add`.'),
        name: stringProp('Note name for global `add`. Slugified from content if omitted.'),
        path: stringProp('Note path for `read` and `remove` (e.g. "inbox/my-note.md").'),
      },
      required: ['action'],
    },
  },
] as const;

export function buildCheckpointReminder(threadId?: string): string {
  return [
    '---',
    threadId === undefined ? `Session ID: ${SESSION_ID}` : `Session ID: ${SESSION_ID} | Thread: ${threadId}`,
    'Scratch: append at milestones. Close-out: scratch compact/delete then memory store.',
  ].join('\n');
}
