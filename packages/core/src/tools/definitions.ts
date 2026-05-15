import { randomUUID } from 'node:crypto';
import {
  MemoryState,
  MemoryType,
  ThreadStatus,
} from '../types.js';

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
export const SHORT_PREVIEW_TOKENS = 30;
export const LONG_PREVIEW_TOKENS = 50;
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
export const THREAD_STATUSES = ['planned', 'active', 'paused', 'closed'] as const;

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
  planned: ThreadStatus.Planned,
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
    description: 'Manage vault memories. Actions: store, read, update, search, list, archive.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['store', 'read', 'update', 'search', 'list', 'archive'] as const, 'Action.'),
        path: stringProp('Memory path (read, update).'),
        content: stringProp('Body text (store, update).'),
        type: enumProp(MEMORY_TYPES, 'Type filter.'),
        tags: stringArrayProp('Tags.'),
        confidence: enumProp(CONFIDENCE_VALUES, 'Confidence (facts).'),
        state: enumProp(MEMORY_STATES, 'Retrieval priority.'),
        limit: numberProp('Max results.'),
        query: stringProp('Search query.'),
        bootstrap_state: enumProp(BOOTSTRAP_STATES, 'Author context quality.'),
        agent: stringProp('Agent filter/tag.'),
        platform: stringProp('Platform filter/tag.'),
        session_id: stringProp('Session UUID.'),
        summary: stringProp('Summary for context loading.'),
        thread: stringProp('Thread scope (omit for global).'),
        older_than_days: numberProp('Min age in days (archive).'),
      },
      required: ['action'],
    },
  },
  {
    name: 'soul',
    description: 'Manage the Soul document. Actions: get, set.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['get', 'set'] as const, 'Action.'),
        content: stringProp('Soul content (set).'),
      },
      required: ['action'],
    },
  },
  {
    name: 'context',
    description: 'Load scoped session context.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['load'] as const, 'Action.'),
        query: stringProp('Task or focus description.'),
        token_budget: numberProp('Token budget (default 2000).'),
        thread_id: stringProp('Active thread ID.'),
      },
      required: ['action', 'query'],
    },
  },
  {
    name: 'note',
    description: 'Manage working notes. Actions: create, read, update, append, list, search, delete.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(
          ['create', 'read', 'update', 'append', 'list', 'search', 'delete'] as const,
          'Action.',
        ),
        path: stringProp('Relative path (e.g. "blog/session-21"). .md auto-appended.'),
        content: stringProp('Markdown body.'),
        separator: stringProp('Append separator (default: blank line).'),
        expected_current_content: stringProp('Concurrency guard (update, append).'),
        prefix: stringProp('Prefix filter (list).'),
        query: stringProp('Search query.'),
        limit: numberProp('Max results.'),
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
        action: enumProp(['save'] as const, 'Action.'),
        messages: {
          type: 'array',
          description: 'Messages.',
          items: {
            type: 'object',
            properties: {
              role: { type: 'string', enum: ['user', 'assistant', 'system'] },
              content: { type: 'string' },
            },
            required: ['role', 'content'],
          },
        },
        summary: stringProp('One-line summary.'),
        tags: stringArrayProp('Tags.'),
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
        action: enumProp(['store', 'get', 'list'] as const, 'Action.'),
        slug: stringProp('Skill slug.'),
        content: stringProp('Skill content (store).'),
        tags: stringArrayProp('Tags.'),
      },
      required: ['action'],
    },
  },
  {
    name: 'scratch',
    description: 'Shared scratch log. Actions: append, read, read_dream, compact, prune, delete, clear.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['append', 'read', 'read_dream', 'compact', 'prune', 'delete', 'clear'] as const, 'Action.'),
        content: stringProp('Content (append).'),
        session_id: stringProp('Session UUID filter.'),
        match_text: stringProp('Content substring (delete).'),
        limit: numberProp('Max entries.'),
        since: stringProp('ISO 8601 since filter.'),
        bootstrap: booleanProp('Bootstrap mode (read).'),
        token_budget: numberProp('Token limit for bootstrap read.'),
        threshold_hours: numberProp('Age threshold hours (default 1).'),
        compacted_content: stringProp('Summary replacement (compact).'),
      },
      required: ['action'],
    },
  },
  {
    name: 'thread',
    description: 'Manage threads and todos. Actions: get, set, update, list, resolve, merge, todo_*.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(
          [
            'get', 'set', 'update', 'list', 'resolve', 'merge',
            'todo_list', 'todo_add', 'todo_complete', 'todo_reopen', 'todo_remove',
          ] as const,
          'Action.',
        ),
        thread_id: stringProp('Thread slug.'),
        source_thread_id: stringProp('Merge source.'),
        target_thread_id: stringProp('Merge target.'),
        content: stringProp('Body markdown.'),
        name: stringProp('Thread name.'),
        description: stringProp('Description.'),
        status: enumProp(THREAD_STATUSES, 'Status.'),
        goals: stringArrayProp('Goals.'),
        paths: stringArrayProp('Associated paths.'),
        repositories: stringArrayProp('Associated git remote URLs.'),
        packages: stringArrayProp('Associated package names (e.g. package.json "name").'),
        aliases: stringArrayProp('Alternate thread IDs that resolve to this thread.'),
        superseded_by: stringProp('Forward pointer — resolves redirect to this thread ID.'),
        related_threads: stringArrayProp('Related thread IDs.'),
        tags: stringArrayProp('Tags.'),
        cwd: stringProp('Working directory (resolve).'),
        git_remote: stringProp('Git remote URL (resolve; auto-detected from cwd if omitted).'),
        auto_create: booleanProp('Auto-create on resolve.'),
        item: stringProp('Todo item text.'),
        include_completed: booleanProp('Include done items.'),
        prepend: booleanProp('Insert at top.'),
        force: booleanProp('Override coherence warnings on set/update (when content references a different thread or unknown project).'),
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
        action: enumProp(['list', 'add', 'read', 'remove'] as const, 'Action.'),
        thread_id: stringProp('Thread scope (omit for global).'),
        content: stringProp('Content (add).'),
        name: stringProp('Name (global add, auto-slugified).'),
        path: stringProp('Item path (read, remove).'),
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
