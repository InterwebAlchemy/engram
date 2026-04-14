import { randomUUID } from 'node:crypto';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager, MemoryType, MemoryState, ThreadStatus } from '@interwebalchemy/engram-core';

// Generated once per server process — stable for the lifetime of this session.
const SESSION_ID = randomUUID();

const MEMORY_TYPES = ['fact', 'entity', 'reflection'] as const;
const MEMORY_STATES = ['core', 'remembered', 'default', 'forgotten'] as const;
const BOOTSTRAP_STATES = ['full', 'partial', 'none'] as const;
const THREAD_STATUSES = ['active', 'paused', 'closed'] as const;

const stringProp = (description: string) => ({ type: 'string', description });
const numberProp = (description: string) => ({ type: 'number', description });
const booleanProp = (description: string) => ({ type: 'boolean', description });
const enumProp = <T extends readonly string[]>(values: T, description: string) => ({
  type: 'string',
  enum: [...values],
  description,
});
const stringArrayProp = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

// ─── Tool schema definitions ──────────────────────────────────────────────────

const TOOLS = [
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
        confidence: enumProp(['high', 'medium', 'low'] as const, 'Confidence level for facts.'),
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
    description: 'Manage the shared scratch log. Actions: append, read, compact, clear.',
    inputSchema: {
      type: 'object',
      properties: {
        action: enumProp(['append', 'read', 'compact', 'clear'] as const, 'Scratch action to perform.'),
        content: stringProp('Scratch content for `append`.'),
        session_id: stringProp(
          'Session UUID for `read` filtering or `compact` targeting.',
        ),
        limit: numberProp('Maximum number of scratch entries to return.'),
        since: stringProp('ISO 8601 timestamp filter for `read`.'),
        bootstrap: booleanProp('Apply bootstrap pruning and dream-sequence compaction for `read`.'),
        threshold_hours: numberProp('Age threshold in hours for `compact`. Defaults to 1.'),
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

const MEMORY_TYPE_MAP: Record<string, MemoryType> = {
  fact: MemoryType.Fact,
  entity: MemoryType.Entity,
  reflection: MemoryType.Reflection,
};

const MEMORY_STATE_MAP: Record<string, MemoryState> = {
  core: MemoryState.Core,
  remembered: MemoryState.Remembered,
  default: MemoryState.Default,
  forgotten: MemoryState.Forgotten,
};

const THREAD_STATUS_MAP: Record<string, ThreadStatus> = {
  active: ThreadStatus.Active,
  paused: ThreadStatus.Paused,
  closed: ThreadStatus.Closed,
};

type ToolArgs = Record<string, unknown>;

function toolArgs(args: unknown): ToolArgs {
  return (args && typeof args === 'object' ? args : {}) as ToolArgs;
}

function textResult(text: string, isError = false) {
  return isError
    ? { content: [{ type: 'text' as const, text }], isError: true }
    : { content: [{ type: 'text' as const, text }] };
}

function requireStringArg(args: ToolArgs, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

function optionalStringArg(args: ToolArgs, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`Expected string argument: ${key}`);
  }
  return value;
}

function optionalNumberArg(args: ToolArgs, key: string): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number') {
    throw new Error(`Expected number argument: ${key}`);
  }
  return value;
}

function optionalBooleanArg(args: ToolArgs, key: string): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean argument: ${key}`);
  }
  return value;
}

function optionalStringArrayArg(args: ToolArgs, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Expected string[] argument: ${key}`);
  }
  return value;
}

function optionalMessagesArg(
  args: ToolArgs,
  key: string,
): Array<{ role: 'user' | 'assistant' | 'system'; content: string }> | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        typeof (item as { role?: unknown }).role !== 'string' ||
        typeof (item as { content?: unknown }).content !== 'string',
    )
  ) {
    throw new Error(`Expected messages array argument: ${key}`);
  }
  return value as Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
}

function optionalMappedArg<T>(
  args: ToolArgs,
  key: string,
  map: Record<string, T>,
): T | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(value in map)) {
    throw new Error(`Invalid argument for ${key}: ${String(value)}`);
  }
  return map[value];
}

function requiredMappedArg<T>(
  args: ToolArgs,
  key: string,
  map: Record<string, T>,
): T {
  const value = requireStringArg(args, key);
  if (!(value in map)) {
    throw new Error(`Invalid argument for ${key}: ${value}`);
  }
  return map[value];
}

function buildCheckpointReminder(threadId?: string): string {
  return [
    '---',
    threadId ? `Session ID: ${SESSION_ID} | Thread: ${threadId}` : `Session ID: ${SESSION_ID}`,
    'Scratch: append at milestones. Close-out: scratch compact then memory store.',
  ].join('\n');
}

// ─── Tool registration ─────────────────────────────────────────────────────────

export function registerTools(server: Server, manager: MemoryManager): void {
  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Dispatch tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = toolArgs(args);

    try {
      switch (name) {
        case 'memory': {
          switch (requireStringArg(a, 'action')) {
            case 'store': {
              const note = await manager.store(
                requireStringArg(a, 'content'),
                requiredMappedArg(a, 'type', MEMORY_TYPE_MAP),
                optionalStringArrayArg(a, 'tags') ?? [],
                undefined,
                optionalStringArg(a, 'confidence') as 'high' | 'medium' | 'low' | undefined,
              );
              const metaUpdates: Record<string, unknown> = {};
              if (a.state !== undefined) metaUpdates.memory_state = optionalStringArg(a, 'state');
              if (a.session_id !== undefined) metaUpdates.session_id = optionalStringArg(a, 'session_id');
              if (a.bootstrap_state !== undefined) metaUpdates.bootstrap_state = optionalStringArg(a, 'bootstrap_state');
              if (a.agent !== undefined) metaUpdates.agent = optionalStringArg(a, 'agent');
              if (a.platform !== undefined) metaUpdates.platform = optionalStringArg(a, 'platform');
              if (a.summary !== undefined) metaUpdates.summary = optionalStringArg(a, 'summary');
              if (a.thread !== undefined) metaUpdates.thread = optionalStringArg(a, 'thread');
              if (Object.keys(metaUpdates).length > 0) {
                await manager.update(note.path, undefined, metaUpdates);
              }
              return textResult(`Stored memory at: ${note.path}`);
            }

            case 'read': {
              const note = await manager.read(requireStringArg(a, 'path'));
              return textResult(note.serialize());
            }

            case 'update': {
              const fmUpdates: Record<string, unknown> = {};
              if (a.type !== undefined) fmUpdates.type = optionalMappedArg(a, 'type', MEMORY_TYPE_MAP);
              if (a.tags !== undefined) fmUpdates.tags = optionalStringArrayArg(a, 'tags');
              if (a.state !== undefined) fmUpdates.memory_state = optionalMappedArg(a, 'state', MEMORY_STATE_MAP);
              if (a.session_id !== undefined) fmUpdates.session_id = optionalStringArg(a, 'session_id');
              if (a.bootstrap_state !== undefined) fmUpdates.bootstrap_state = optionalStringArg(a, 'bootstrap_state');
              if (a.agent !== undefined) fmUpdates.agent = optionalStringArg(a, 'agent');
              if (a.platform !== undefined) fmUpdates.platform = optionalStringArg(a, 'platform');
              if (a.summary !== undefined) fmUpdates.summary = optionalStringArg(a, 'summary');
              if (a.thread !== undefined) fmUpdates.thread = optionalStringArg(a, 'thread');
              const note = await manager.update(
                requireStringArg(a, 'path'),
                optionalStringArg(a, 'content'),
                Object.keys(fmUpdates).length > 0 ? fmUpdates : undefined,
              );
              return textResult(`Updated memory at: ${note.path}`);
            }

            case 'search': {
              const notes = await manager.search(requireStringArg(a, 'query'), {
                type: optionalMappedArg(a, 'type', MEMORY_TYPE_MAP),
                tags: optionalStringArrayArg(a, 'tags'),
                limit: optionalNumberArg(a, 'limit') ?? 10,
                bootstrap_state: optionalStringArg(a, 'bootstrap_state') as
                  | 'full'
                  | 'partial'
                  | 'none'
                  | undefined,
                agent: optionalStringArg(a, 'agent'),
                platform: optionalStringArg(a, 'platform'),
                thread: optionalStringArg(a, 'thread'),
              });
              const results = notes.map((note) => ({
                path: note.path,
                type: note.frontmatter.type,
                state: note.frontmatter.memory_state,
                tags: note.frontmatter.tags ?? [],
                bootstrap_state: note.frontmatter.bootstrap_state,
                agent: note.frontmatter.agent,
                platform: note.frontmatter.platform,
                preview: note.content.slice(0, 200),
              }));
              return textResult(JSON.stringify(results, null, 2));
            }

            case 'list': {
              const notes = await manager.list({
                type: optionalMappedArg(a, 'type', MEMORY_TYPE_MAP),
                state: optionalMappedArg(a, 'state', MEMORY_STATE_MAP),
                limit: optionalNumberArg(a, 'limit') ?? 20,
                bootstrap_state: optionalStringArg(a, 'bootstrap_state') as
                  | 'full'
                  | 'partial'
                  | 'none'
                  | undefined,
                agent: optionalStringArg(a, 'agent'),
                platform: optionalStringArg(a, 'platform'),
                thread: optionalStringArg(a, 'thread'),
              });
              const results = notes.map((note) => ({
                path: note.path,
                type: note.frontmatter.type,
                state: note.frontmatter.memory_state,
                tags: note.frontmatter.tags ?? [],
                created: note.frontmatter.created,
                bootstrap_state: note.frontmatter.bootstrap_state,
                agent: note.frontmatter.agent,
                platform: note.frontmatter.platform,
                preview: note.content.slice(0, 120),
              }));
              return textResult(JSON.stringify(results, null, 2));
            }

            case 'archive': {
              const archived = await manager.archiveForgotten(optionalNumberArg(a, 'older_than_days'));
              const message = archived.length > 0
                ? `Archived ${archived.length} forgotten note(s):\n${archived.join('\n')}`
                : 'No forgotten notes matched the criteria.';
              return textResult(message);
            }

            default:
              return textResult(`Unknown memory action: ${String(a.action)}`, true);
          }
        }

        case 'soul': {
          switch (requireStringArg(a, 'action')) {
            case 'get': {
              const soul = await manager.getSoulDocument();
              return textResult(`${soul ? soul.serialize() : 'No Soul document found.'}\n\n---\nSession ID: ${SESSION_ID}`);
            }
            case 'set': {
              const soul = await manager.setSoulDocument(requireStringArg(a, 'content'));
              return textResult(`Soul document written to: ${soul.path}`);
            }
            default:
              return textResult(`Unknown soul action: ${String(a.action)}`, true);
          }
        }

        case 'context': {
          if (requireStringArg(a, 'action') !== 'load') {
            return textResult(`Unknown context action: ${String(a.action)}`, true);
          }
          const threadId = optionalStringArg(a, 'thread_id');
          const sections = await manager.getContext(
            requireStringArg(a, 'query'),
            { max: optionalNumberArg(a, 'token_budget') ?? 2000 },
            threadId,
          );
          if (sections.length === 0) {
            return textResult('No context found.');
          }
          const contextText = sections
            .map((section) => `### ${section.label}\n\n${section.content}`)
            .join('\n\n---\n\n');
          return textResult(`${contextText}\n\n${buildCheckpointReminder(threadId)}`);
        }

        case 'note': {
          switch (requireStringArg(a, 'action')) {
            case 'create': {
              const notePath = await manager.createNote(
                requireStringArg(a, 'path'),
                requireStringArg(a, 'content'),
              );
              return textResult(`Created note at: ${notePath}`);
            }
            case 'read': {
              return textResult(await manager.readNote(requireStringArg(a, 'path')));
            }
            case 'update': {
              const notePath = await manager.updateNote(
                requireStringArg(a, 'path'),
                requireStringArg(a, 'content'),
                optionalStringArg(a, 'expected_current_content'),
              );
              return textResult(`Updated note at: ${notePath}`);
            }
            case 'append': {
              const notePath = await manager.appendNote(
                requireStringArg(a, 'path'),
                requireStringArg(a, 'content'),
                {
                  separator: optionalStringArg(a, 'separator'),
                  expectedCurrentContent: optionalStringArg(a, 'expected_current_content'),
                },
              );
              return textResult(`Appended to note at: ${notePath}`);
            }
            case 'list': {
              const notes = await manager.listNotes({
                limit: optionalNumberArg(a, 'limit') ?? 20,
                prefix: optionalStringArg(a, 'prefix'),
              });
              return textResult(JSON.stringify(notes, null, 2));
            }
            case 'search': {
              const results = await manager.searchNotes(requireStringArg(a, 'query'), {
                limit: optionalNumberArg(a, 'limit') ?? 10,
              });
              return textResult(JSON.stringify(results, null, 2));
            }
            case 'delete': {
              const notePath = await manager.deleteNote(requireStringArg(a, 'path'));
              return textResult(`Deleted note at: ${notePath}`);
            }
            default:
              return textResult(`Unknown note action: ${String(a.action)}`, true);
          }
        }

        case 'conversation': {
          if (requireStringArg(a, 'action') !== 'save') {
            return textResult(`Unknown conversation action: ${String(a.action)}`, true);
          }
          const note = await manager.storeConversation(
            optionalMessagesArg(a, 'messages') ?? [],
            optionalStringArg(a, 'summary'),
            optionalStringArrayArg(a, 'tags') ?? [],
          );
          return textResult(`Saved conversation at: ${note.path}`);
        }

        case 'skill': {
          switch (requireStringArg(a, 'action')) {
            case 'store': {
              const note = await manager.storeSkill(
                requireStringArg(a, 'slug'),
                requireStringArg(a, 'content'),
                optionalStringArrayArg(a, 'tags') ?? [],
              );
              return textResult(`Stored skill at: ${note.path}`);
            }
            case 'get': {
              const note = await manager.getSkill(requireStringArg(a, 'slug'));
              if (!note) return textResult(`Skill not found: ${requireStringArg(a, 'slug')}`, true);
              return textResult(note.serialize());
            }
            case 'list': {
              const notes = await manager.listSkills();
              const results = notes.map((note) => ({
                slug: note.path.split('/').pop()?.replace(/\.md$/, '') ?? note.path,
                tags: note.frontmatter.tags ?? [],
                updated: note.frontmatter.updated,
                preview: note.content.slice(0, 120),
              }));
              return textResult(JSON.stringify(results, null, 2));
            }
            default:
              return textResult(`Unknown skill action: ${String(a.action)}`, true);
          }
        }

        case 'scratch': {
          switch (requireStringArg(a, 'action')) {
            case 'append': {
              await manager.appendScratch(SESSION_ID, requireStringArg(a, 'content'));
              return textResult('Appended to scratch log.');
            }
            case 'read': {
              const entries = await manager.readScratch({
                sessionId: optionalStringArg(a, 'session_id'),
                limit: optionalNumberArg(a, 'limit'),
                since: optionalStringArg(a, 'since'),
                bootstrap: optionalBooleanArg(a, 'bootstrap'),
              });
              if (entries.length === 0) return textResult('Scratch log is empty.');
              return textResult(
                entries.map((entry) => `[${entry.sessionId} | ${entry.timestamp}] ${entry.content}`).join('\n'),
              );
            }
            case 'compact': {
              const sessionId = requireStringArg(a, 'session_id');
              await manager.compactScratch({
                sessionId,
                thresholdMs: (optionalNumberArg(a, 'threshold_hours') ?? 1) * 60 * 60 * 1000,
                compactedContent: requireStringArg(a, 'compacted_content'),
              });
              return textResult(`Compacted scratch entries for session ${sessionId}.`);
            }
            case 'clear': {
              await manager.clearScratch();
              return textResult('Cleared scratch log.');
            }
            default:
              return textResult(`Unknown scratch action: ${String(a.action)}`, true);
          }
        }

        case 'thread': {
          switch (requireStringArg(a, 'action')) {
            case 'get': {
              const threadId = requireStringArg(a, 'thread_id');
              const thread = await manager.getThread(threadId);
              if (!thread) return textResult(`Thread not found: ${threadId}`, true);
              return textResult(thread.serialize());
            }
            case 'set': {
              const thread = await manager.setThread(
                requireStringArg(a, 'thread_id'),
                requireStringArg(a, 'content'),
                {
                  name: optionalStringArg(a, 'name'),
                  description: optionalStringArg(a, 'description'),
                  status: optionalMappedArg(a, 'status', THREAD_STATUS_MAP),
                  goals: optionalStringArrayArg(a, 'goals'),
                  paths: optionalStringArrayArg(a, 'paths'),
                  related_threads: optionalStringArrayArg(a, 'related_threads'),
                  tags: optionalStringArrayArg(a, 'tags'),
                },
              );
              return textResult(`Thread written to: ${thread.path}`);
            }
            case 'update': {
              const thread = await manager.updateThread(
                requireStringArg(a, 'thread_id'),
                optionalStringArg(a, 'content'),
                {
                  name: optionalStringArg(a, 'name'),
                  description: optionalStringArg(a, 'description'),
                  status: optionalMappedArg(a, 'status', THREAD_STATUS_MAP),
                  goals: optionalStringArrayArg(a, 'goals'),
                  paths: optionalStringArrayArg(a, 'paths'),
                  related_threads: optionalStringArrayArg(a, 'related_threads'),
                  tags: optionalStringArrayArg(a, 'tags'),
                },
              );
              return textResult(`Thread updated at: ${thread.path}`);
            }
            case 'list': {
              const threads = await manager.listThreads();
              const results = threads.map((thread) => ({
                thread_id: thread.frontmatter.thread_id,
                name: thread.frontmatter.name,
                status: thread.frontmatter.status,
                description: thread.frontmatter.description,
                goals: thread.frontmatter.goals ?? [],
                paths: thread.frontmatter.paths ?? [],
                related_threads: thread.frontmatter.related_threads ?? [],
                updated: thread.frontmatter.updated,
              }));
              return textResult(JSON.stringify(results, null, 2));
            }
            case 'resolve': {
              const result = await manager.resolveThread({
                cwd: optionalStringArg(a, 'cwd'),
                gitRemote: optionalStringArg(a, 'git_remote'),
                autoCreate: optionalBooleanArg(a, 'auto_create'),
              });
              return textResult(
                JSON.stringify(
                  {
                    thread_id: result.threadId,
                    status: result.created ? 'created' : 'found',
                    thread: result.thread.serialize(),
                  },
                  null,
                  2,
                ),
              );
            }
            case 'merge': {
              const result = await manager.mergeThreads(
                requireStringArg(a, 'source_thread_id'),
                requireStringArg(a, 'target_thread_id'),
              );
              return textResult(
                JSON.stringify(
                  {
                    source_thread_id: requireStringArg(a, 'source_thread_id'),
                    target_thread_id: requireStringArg(a, 'target_thread_id'),
                    retagged_count: result.retaggedCount,
                    source_status: 'closed',
                  },
                  null,
                  2,
                ),
              );
            }
            case 'todo_list': {
              const todos = await manager.listThreadTodos(
                requireStringArg(a, 'thread_id'),
                { includeCompleted: optionalBooleanArg(a, 'include_completed') },
              );
              return textResult(JSON.stringify(todos, null, 2));
            }
            case 'todo_add': {
              const thread = await manager.addThreadTodo(
                requireStringArg(a, 'thread_id'),
                requireStringArg(a, 'item'),
                { prepend: optionalBooleanArg(a, 'prepend') },
              );
              return textResult(`Thread todo updated at: ${thread.path}`);
            }
            case 'todo_complete': {
              const thread = await manager.completeThreadTodo(
                requireStringArg(a, 'thread_id'),
                requireStringArg(a, 'item'),
              );
              return textResult(`Thread todo completed at: ${thread.path}`);
            }
            case 'todo_reopen': {
              const thread = await manager.reopenThreadTodo(
                requireStringArg(a, 'thread_id'),
                requireStringArg(a, 'item'),
              );
              return textResult(`Thread todo reopened at: ${thread.path}`);
            }
            case 'todo_remove': {
              const thread = await manager.removeThreadTodo(
                requireStringArg(a, 'thread_id'),
                requireStringArg(a, 'item'),
              );
              return textResult(`Thread todo removed at: ${thread.path}`);
            }
            default:
              return textResult(`Unknown thread action: ${String(a.action)}`, true);
          }
        }

        case 'inbox': {
          const a = args as Record<string, unknown>;
          switch (a.action) {
            case 'list': {
              const threadId = optionalStringArg(a, 'thread_id');
              if (threadId) {
                const items = await manager.listThreadInbox(threadId);
                return textResult(JSON.stringify(items, null, 2));
              }
              const items = await manager.listGlobalInbox();
              return textResult(JSON.stringify(items, null, 2));
            }
            case 'add': {
              const content = requireStringArg(a, 'content');
              const threadId = optionalStringArg(a, 'thread_id');
              if (threadId) {
                const itemPath = await manager.addThreadInboxItem(threadId, content);
                return textResult(`Inbox item created at: ${itemPath}`);
              }
              const name = optionalStringArg(a, 'name');
              const itemPath = await manager.addGlobalInboxItem(content, name ?? undefined);
              return textResult(`Inbox item created at: ${itemPath}`);
            }
            case 'read': {
              const itemPath = requireStringArg(a, 'path');
              const content = await manager.readNote(itemPath);
              return textResult(content);
            }
            case 'remove': {
              const itemPath = optionalStringArg(a, 'path');
              const threadId = optionalStringArg(a, 'thread_id');
              if (threadId && !itemPath) {
                return textResult('Either `path` or both `thread_id` and `path` are required for `remove`.', true);
              }
              if (itemPath) {
                const removed = await manager.removeInboxItem(itemPath);
                return textResult(`Inbox item removed: ${removed}`);
              }
              return textResult('`path` is required for `remove`.', true);
            }
            default:
              return textResult(`Unknown inbox action: ${String(a.action)}`, true);
          }
        }

        default:
          return textResult(`Unknown tool: ${name}`, true);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return textResult(`Error: ${message}`, true);
    }
  });

  // ─── Resources ───────────────────────────────────────────────────────────────

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const soul = await manager.getSoulDocument();
    return {
      resources: soul
        ? [
            {
              uri: 'engram://soul',
              name: 'Soul Document',
              description: 'Persistent identity and self-model for this agent. Read at session start.',
              mimeType: 'text/markdown',
            },
          ]
        : [],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === 'engram://soul') {
      const soul = await manager.getSoulDocument();
      if (!soul) {
        throw new Error('Soul document not found.');
      }
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: soul.content,
          },
        ],
      };
    }
    throw new Error(`Unknown resource: ${uri}`);
  });
}
