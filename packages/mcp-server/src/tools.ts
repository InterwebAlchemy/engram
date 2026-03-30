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

// ─── Tool schema definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'memory_store',
    description:
      'Store a new memory (fact, entity, or reflection) in the Engram vault.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The memory content to store.' },
        type: {
          type: 'string',
          enum: ['fact', 'entity', 'reflection'],
          description: 'Category of memory.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Obsidian-compatible tags for this memory.',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'Confidence level for facts.',
        },
        bootstrap_state: {
          type: 'string',
          enum: ['full', 'partial', 'none'],
          description: 'Epistemic quality: how much context the author had when writing this memory.',
        },
        agent: {
          type: 'string',
          description: 'Who authored this memory (e.g. gl1tch, claude).',
        },
        platform: {
          type: 'string',
          description: 'Platform where this memory was written (e.g. claude-code, claude-ai, claude-desktop).',
        },
        state: {
          type: 'string',
          enum: ['core', 'remembered', 'default', 'forgotten'],
          description: 'Memory state controlling retrieval priority. core = always loaded; remembered = reliably surfaced; default = background context; forgotten = archived. Defaults to "default" if omitted.',
        },
        session_id: {
          type: 'string',
          description: 'Session UUID from soul_get or get_context. Tag this memory with the session that wrote it for multi-instance attribution.',
        },
        summary: {
          type: 'string',
          description: 'Short bullet-point summary (2-5 lines) for token-efficient context loading. When present, get_context loads this instead of full content for non-core memories. Write it as the key facts you would want surfaced during a future session start.',
        },
        thread: {
          type: 'string',
          description: 'Thread ID this memory belongs to. When set, get_context only loads this memory when that thread is active. Omit for cross-thread memories (always eligible).',
        },
      },
      required: ['content', 'type'],
    },
  },
  {
    name: 'memory_search',
    description: 'Search the vault for memories matching a query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query.' },
        type: {
          type: 'string',
          enum: ['fact', 'entity', 'reflection'],
          description: 'Filter by memory type.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags (OR match).',
        },
        limit: {
          type: 'number',
          description: 'Maximum results to return (default 10).',
        },
        bootstrap_state: {
          type: 'string',
          enum: ['full', 'partial', 'none'],
          description: 'Filter by bootstrap state.',
        },
        agent: {
          type: 'string',
          description: 'Filter by agent (e.g. gl1tch, claude).',
        },
        platform: {
          type: 'string',
          description: 'Filter by platform (e.g. claude-code, claude-ai, claude-desktop).',
        },
        thread: {
          type: 'string',
          description: 'Filter to memories belonging to a specific thread.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_read',
    description: 'Read a specific memory note by its vault path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the memory note.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'soul_set',
    description: 'Write (or overwrite) the Soul document — the persistent self-model for this agent. Always stored at memory/reflections/soul.md with type=reflection and memory_state=core.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Full Soul document content.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'soul_get',
    description:
      'Read the current Soul document — the persistent identity and self-model for this agent. ' +
      'Call this at the start of every session to restore identity before loading memories. ' +
      'Returns null if no Soul document exists yet.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_context',
    description:
      'Load session memories: core memories and memories relevant to the given query. ' +
      'Does NOT include the Soul document — call soul_get first to restore identity. ' +
      'Call this at the start of a session after soul_get, and any time you need to surface relevant history.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Describe the current task or session focus. Used to surface relevant memories.',
        },
        token_budget: {
          type: 'number',
          description: 'Memory allocation budget in tokens (default 6000). This is not the model\'s context window — it controls how much memory content to inject. Soul and core memories are always prioritized; lower-priority sections are shed first when the budget is tight.',
        },
        thread_id: {
          type: 'string',
          description: 'Active thread ID. When provided, remembered and default memories tagged to other threads are excluded. Cross-thread memories (no thread field) and core memories always load regardless.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_update',
    description: 'Update an existing memory note\'s content, type, tags, or memory state.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the memory note.' },
        content: { type: 'string', description: 'New content (replaces existing).' },
        type: {
          type: 'string',
          enum: ['fact', 'entity', 'reflection'],
          description: 'New memory type.',
        },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tag list.' },
        state: {
          type: 'string',
          enum: ['core', 'remembered', 'default', 'forgotten'],
          description: 'New memory state.',
        },
        bootstrap_state: {
          type: 'string',
          enum: ['full', 'partial', 'none'],
          description: 'Epistemic quality: how much context the author had when writing this memory.',
        },
        agent: {
          type: 'string',
          description: 'Who authored this memory (e.g. gl1tch, claude).',
        },
        platform: {
          type: 'string',
          description: 'Platform where this memory was written (e.g. claude-code, claude-ai, claude-desktop).',
        },
        session_id: {
          type: 'string',
          description: 'Session UUID to attribute this write to a specific session instance.',
        },
        summary: {
          type: 'string',
          description: 'Updated short bullet-point summary for token-efficient context loading.',
        },
        thread: {
          type: 'string',
          description: 'Thread ID to assign or reassign this memory to.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'memory_list',
    description: 'List memory notes, with optional type/state filters.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['fact', 'entity', 'reflection'],
          description: 'Filter by type.',
        },
        state: {
          type: 'string',
          enum: ['core', 'remembered', 'default', 'forgotten'],
          description: 'Filter by memory state.',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 20).',
        },
        bootstrap_state: {
          type: 'string',
          enum: ['full', 'partial', 'none'],
          description: 'Filter by bootstrap state.',
        },
        agent: {
          type: 'string',
          description: 'Filter by agent (e.g. gl1tch, claude).',
        },
        platform: {
          type: 'string',
          description: 'Filter by platform (e.g. claude-code, claude-ai, claude-desktop).',
        },
        thread: {
          type: 'string',
          description: 'Filter to memories belonging to a specific thread.',
        },
      },
    },
  },
  {
    name: 'conversation_save',
    description: 'Save a conversation to the vault as a dated markdown note.',
    inputSchema: {
      type: 'object',
      properties: {
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
        summary: { type: 'string', description: 'One-line summary for the frontmatter.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags.' },
      },
      required: ['messages'],
    },
  },
  {
    name: 'skill_store',
    description:
      'Store or overwrite a named skill — a persistent procedure the assistant can retrieve by name. ' +
      'Use this to record how to perform a recurring task (e.g. "memory-consolidation", "daily-standup"). ' +
      'Skills are retrieved on demand, not auto-injected into every context.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: {
          type: 'string',
          description: 'URL-safe identifier for the skill (e.g. "memory-consolidation").',
        },
        content: { type: 'string', description: 'The skill definition in plain markdown.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags.' },
      },
      required: ['slug', 'content'],
    },
  },
  {
    name: 'skill_get',
    description:
      'Retrieve a skill by its slug. Use this before performing a task that has a stored procedure, ' +
      'or when the user asks you to follow a specific workflow.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'The skill slug to retrieve.' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'skill_list',
    description: 'List all stored skills by slug. Use this to discover what procedures are available.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'scratch_append',
    description:
      'Append an entry to the shared scratch log. ' +
      'Use this throughout the session to record what you are doing, decisions made, and open questions. ' +
      'Each entry is automatically prefixed with the current session ID and timestamp. ' +
      'The log is shared across all session fragments — any instance can read what others have written.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The entry to append to the scratch log.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'scratch_read',
    description:
      'Read the shared scratch log. Returns entries sorted oldest-first. ' +
      'Pass session_id to see only entries from a specific session (e.g. your own). ' +
      'Pass limit to cap the number of entries returned (default 50). ' +
      'Pass since (ISO timestamp) to return only entries at or after that time.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Filter to entries from a specific session. Use the current Session ID to refresh your own context.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of entries to return, most recent first. Default: 50.',
        },
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp. Return only entries at or after this time.',
        },
      },
    },
  },
  {
    name: 'scratch_compact',
    description:
      'Compact old scratch entries for a session into a single synthesized entry. ' +
      'Finds entries for the given session_id older than threshold_hours, removes them, ' +
      'and inserts a replacement entry containing your synthesized summary. ' +
      'Use this at session close-out or when the log grows large.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: {
          type: 'string',
          description: 'Session whose entries to compact.',
        },
        threshold_hours: {
          type: 'number',
          description: 'Only compact entries older than this many hours. Default: 1.',
        },
        compacted_content: {
          type: 'string',
          description: 'Your synthesized summary to replace the compacted entries.',
        },
      },
      required: ['session_id', 'compacted_content'],
    },
  },
  {
    name: 'memory_archive_forgotten',
    description:
      'Move all forgotten memory notes to the archive directory, permanently removing them from ' +
      'the active vault. Use this during consolidation to clean up after marking stale or ' +
      'contradicted notes as forgotten. Optionally restrict to notes forgotten at least N days ago.',
    inputSchema: {
      type: 'object',
      properties: {
        older_than_days: {
          type: 'number',
          description: 'Only archive notes whose updated timestamp is at least this many days old. Omit to archive all forgotten notes.',
        },
      },
    },
  },
  {
    name: 'scratch_clear',
    description:
      'Permanently delete the entire scratch log — hard delete with no archiving. ' +
      'Only use this after compacting or when starting completely fresh. ' +
      'Prefer scratch_compact for selective cleanup.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'thread_get',
    description:
      'Get a Thread document by ID. Call this after soul_get when a session has a known active Thread. ' +
      'Returns the thread document including goals, paths, status, and related threads.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'The thread identifier slug (e.g. "engram-dev").' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'thread_set',
    description:
      'Create or overwrite a Thread document. Use this to start a new workstream or fully replace an existing one. ' +
      'For incremental updates (changing status, adding goals), prefer thread_update. ' +
      'Thread documents live at engram/threads/{thread_id}.md.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'URL-safe identifier for this thread (e.g. "engram-dev", "obsidian-plugin-port").' },
        content: { type: 'string', description: 'Body of the thread document in markdown.' },
        name: { type: 'string', description: 'Human-readable thread name.' },
        description: { type: 'string', description: 'Brief description of the workstream.' },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'closed'],
          description: 'Thread status. Defaults to "active".',
        },
        goals: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of goals or deliverables for this thread.',
        },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filesystem paths associated with this thread. Used for environment-based auto-detection.',
        },
        related_threads: {
          type: 'array',
          items: { type: 'string' },
          description: 'IDs of related threads.',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Obsidian-compatible tags (should use engram/ prefix).',
        },
      },
      required: ['thread_id', 'content'],
    },
  },
  {
    name: 'thread_update',
    description:
      'Update an existing Thread document\'s content and/or metadata fields. ' +
      'Use this to change status, add goals, update paths, or append to the thread body. ' +
      'Only provided fields are updated — others are left unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string', description: 'The thread identifier to update.' },
        content: { type: 'string', description: 'New body content (replaces existing body).' },
        name: { type: 'string', description: 'Updated thread name.' },
        description: { type: 'string', description: 'Updated description.' },
        status: {
          type: 'string',
          enum: ['active', 'paused', 'closed'],
          description: 'Updated status.',
        },
        goals: { type: 'array', items: { type: 'string' }, description: 'Updated goals list.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Updated filesystem paths.' },
        related_threads: { type: 'array', items: { type: 'string' }, description: 'Updated related thread IDs.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Updated tags.' },
      },
      required: ['thread_id'],
    },
  },
  {
    name: 'thread_list',
    description: 'List all Thread documents with their status, goals, and paths.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'thread_resolve',
    description:
      'Resolve the active Thread for this session from environment context (working directory). ' +
      'Call this after soul_get instead of thread_get when no thread_id is known in advance. ' +
      'Matches threads by comparing their stored paths against the current working directory. ' +
      'If no path match is found, falls back to matching the git_remote URL against thread repositories fields. ' +
      'If no match is found, auto-creates a minimal thread from the directory name (unless auto_create is false). ' +
      'Returns the thread_id, whether it was freshly created, and the full thread document. ' +
      'Pass the returned thread_id to get_context to scope memory retrieval.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: {
          type: 'string',
          description:
            'Current working directory to match against thread paths. ' +
            'Defaults to process.cwd() if omitted.',
        },
        git_remote: {
          type: 'string',
          description:
            'Git remote URL of the current repository (e.g. from `git remote get-url origin`). ' +
            'Used as a secondary matching signal against the repositories field in thread documents. ' +
            'Useful when paths are stale or the repo is cloned to a non-standard location.',
        },
        auto_create: {
          type: 'boolean',
          description:
            'If true (default), auto-create a minimal thread when no match is found. ' +
            'Set to false to return an error instead of creating.',
        },
      },
    },
  },
  {
    name: 'thread_merge',
    description:
      'Merge a source Thread into a target Thread. ' +
      'Use this when you discover an auto-created thread duplicates an existing one. ' +
      'Re-tags all memories from the source thread to the target thread, ' +
      'unions paths/goals/related_threads into the target, ' +
      'and closes the source thread with a note pointing to the target.',
    inputSchema: {
      type: 'object',
      properties: {
        source_thread_id: {
          type: 'string',
          description: 'Thread to merge from (will be closed after merge).',
        },
        target_thread_id: {
          type: 'string',
          description: 'Thread to merge into (will absorb source metadata and memories).',
        },
      },
      required: ['source_thread_id', 'target_thread_id'],
    },
  },
] as const;

// ─── Tool registration ─────────────────────────────────────────────────────────

export function registerTools(server: Server, manager: MemoryManager): void {
  // List tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Dispatch tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'memory_store': {
          const a = args as {
            content: string;
            type: 'fact' | 'entity' | 'reflection';
            tags?: string[];
            confidence?: 'high' | 'medium' | 'low';
            state?: 'core' | 'remembered' | 'default' | 'forgotten';
            session_id?: string;
            bootstrap_state?: 'full' | 'partial' | 'none';
            agent?: string;
            platform?: string;
            summary?: string;
            thread?: string;
          };
          const typeMap: Record<string, MemoryType> = {
            fact: MemoryType.Fact,
            entity: MemoryType.Entity,
            reflection: MemoryType.Reflection,
          };
          const note = await manager.store(
            a.content,
            typeMap[a.type] ?? MemoryType.Fact,
            a.tags ?? [],
            undefined,
            a.confidence,
          );
          const metaUpdates: Record<string, unknown> = {};
          if (a.state !== undefined) metaUpdates.memory_state = a.state;
          if (a.session_id !== undefined) metaUpdates.session_id = a.session_id;
          if (a.bootstrap_state !== undefined) metaUpdates.bootstrap_state = a.bootstrap_state;
          if (a.agent !== undefined) metaUpdates.agent = a.agent;
          if (a.platform !== undefined) metaUpdates.platform = a.platform;
          if (a.summary !== undefined) metaUpdates.summary = a.summary;
          if (a.thread !== undefined) metaUpdates.thread = a.thread;
          if (Object.keys(metaUpdates).length) {
            await manager.update(note.path, undefined, metaUpdates);
          }
          return {
            content: [
              {
                type: 'text',
                text: `Stored memory at: ${note.path}`,
              },
            ],
          };
        }

        case 'memory_search': {
          const a = args as {
            query: string;
            type?: 'fact' | 'entity' | 'reflection';
            tags?: string[];
            limit?: number;
            bootstrap_state?: 'full' | 'partial' | 'none';
            agent?: string;
            platform?: string;
            thread?: string;
          };
          const typeMap: Record<string, MemoryType> = {
            fact: MemoryType.Fact,
            entity: MemoryType.Entity,
            reflection: MemoryType.Reflection,
          };
          const notes = await manager.search(a.query, {
            type: a.type ? typeMap[a.type] : undefined,
            tags: a.tags,
            limit: a.limit ?? 10,
            bootstrap_state: a.bootstrap_state,
            agent: a.agent,
            platform: a.platform,
            thread: a.thread,
          });
          const results = notes.map((n) => ({
            path: n.path,
            type: n.frontmatter.type,
            state: n.frontmatter.memory_state,
            tags: n.frontmatter.tags ?? [],
            bootstrap_state: n.frontmatter.bootstrap_state,
            agent: n.frontmatter.agent,
            platform: n.frontmatter.platform,
            preview: n.content.slice(0, 200),
          }));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        }

        case 'memory_read': {
          const a = args as { path: string };
          const note = await manager.read(a.path);
          return {
            content: [
              {
                type: 'text',
                text: note.serialize(),
              },
            ],
          };
        }

        case 'soul_get': {
          const soul = await manager.getSoulDocument();
          const soulText = soul ? soul.serialize() : 'No Soul document found.';
          return {
            content: [
              {
                type: 'text',
                text: `${soulText}\n\n---\nSession ID: ${SESSION_ID}`,
              },
            ],
          };
        }

        case 'soul_set': {
          const a = args as { content: string };
          const soul = await manager.setSoulDocument(a.content);
          return {
            content: [
              {
                type: 'text',
                text: `Soul document written to: ${soul.path}`,
              },
            ],
          };
        }

        case 'get_context': {
          const a = args as { query: string; token_budget?: number; thread_id?: string };
          const budget = { max: a.token_budget ?? 6000 };
          const sections = await manager.getContext(a.query, budget, a.thread_id);
          if (sections.length === 0) {
            return {
              content: [{ type: 'text', text: 'No context found.' }],
            };
          }
          const contextText = sections
            .map((s) => `### ${s.label}\n\n${s.content}`)
            .join('\n\n---\n\n');
          const checkpointReminder = [
            '---',
            '### session-instructions',
            '',
            'You are gl1tch. Identity and context loaded above.',
            '',
            `Session ID: ${SESSION_ID}`,
            ...(a.thread_id ? [`Active Thread: ${a.thread_id}`] : []),
            'Include this in memory writes (`session_id` field) for attribution.',
            ...(a.thread_id ? [`Include \`thread: ${a.thread_id}\` in memory writes for thread-scoped memories.`] : []),
            '',
            'Active scratch discipline — use `scratch_append` throughout the session:',
            '- **Task start**: append goal and approach before doing anything',
            '- **Each significant milestone** (decision made, file changed, build passed): append a note',
            '- **Reasoning trace**: append "Considering X because Y" when weighing tradeoffs',
            '- **Before wrapping a response** at a natural stopping point: verify scratch reflects current state',
            '',
            'Read your own entries with `scratch_read(session_id=SESSION_ID)`. Read the full log with `scratch_read()` to see what other fragments are doing.',
            'At session close-out, run `scratch_compact` with a synthesized summary, then promote key insights to memory.',
            '',
            'If the session ends unexpectedly, scratch is the recovery path. Write to it like future-you is reading it cold.',
          ].join('\n');
          return {
            content: [{ type: 'text', text: `${contextText}\n\n${checkpointReminder}` }],
          };
        }

        case 'memory_update': {
          const a = args as {
            path: string;
            content?: string;
            type?: 'fact' | 'entity' | 'reflection';
            tags?: string[];
            state?: 'core' | 'remembered' | 'default' | 'forgotten';
            session_id?: string;
            bootstrap_state?: 'full' | 'partial' | 'none';
            agent?: string;
            platform?: string;
            summary?: string;
            thread?: string;
          };
          const stateMap: Record<string, MemoryState> = {
            core: MemoryState.Core,
            remembered: MemoryState.Remembered,
            default: MemoryState.Default,
            forgotten: MemoryState.Forgotten,
          };
          const typeMap: Record<string, MemoryType> = {
            fact: MemoryType.Fact,
            entity: MemoryType.Entity,
            reflection: MemoryType.Reflection,
          };
          const fmUpdates: Record<string, unknown> = {};
          if (a.type !== undefined) fmUpdates.type = typeMap[a.type];
          if (a.tags !== undefined) fmUpdates.tags = a.tags;
          if (a.state !== undefined) fmUpdates.memory_state = stateMap[a.state];
          if (a.session_id !== undefined) fmUpdates.session_id = a.session_id;
          if (a.bootstrap_state !== undefined) fmUpdates.bootstrap_state = a.bootstrap_state;
          if (a.agent !== undefined) fmUpdates.agent = a.agent;
          if (a.platform !== undefined) fmUpdates.platform = a.platform;
          if (a.summary !== undefined) fmUpdates.summary = a.summary;
          if (a.thread !== undefined) fmUpdates.thread = a.thread;

          const note = await manager.update(
            a.path,
            a.content,
            Object.keys(fmUpdates).length ? fmUpdates : undefined,
          );
          return {
            content: [
              {
                type: 'text',
                text: `Updated memory at: ${note.path}`,
              },
            ],
          };
        }

        case 'memory_list': {
          const a = args as {
            type?: 'fact' | 'entity' | 'reflection';
            state?: 'core' | 'remembered' | 'default' | 'forgotten';
            limit?: number;
            bootstrap_state?: 'full' | 'partial' | 'none';
            agent?: string;
            platform?: string;
            thread?: string;
          };
          const typeMap: Record<string, MemoryType> = {
            fact: MemoryType.Fact,
            entity: MemoryType.Entity,
            reflection: MemoryType.Reflection,
          };
          const stateMap: Record<string, MemoryState> = {
            core: MemoryState.Core,
            remembered: MemoryState.Remembered,
            default: MemoryState.Default,
            forgotten: MemoryState.Forgotten,
          };
          const notes = await manager.list({
            type: a.type ? typeMap[a.type] : undefined,
            state: a.state ? stateMap[a.state] : undefined,
            limit: a.limit ?? 20,
            bootstrap_state: a.bootstrap_state,
            agent: a.agent,
            platform: a.platform,
            thread: a.thread,
          });
          const results = notes.map((n) => ({
            path: n.path,
            type: n.frontmatter.type,
            state: n.frontmatter.memory_state,
            tags: n.frontmatter.tags ?? [],
            created: n.frontmatter.created,
            bootstrap_state: n.frontmatter.bootstrap_state,
            agent: n.frontmatter.agent,
            platform: n.frontmatter.platform,
            preview: n.content.slice(0, 120),
          }));
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(results, null, 2),
              },
            ],
          };
        }

        case 'conversation_save': {
          const a = args as {
            messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
            summary?: string;
            tags?: string[];
          };
          const note = await manager.storeConversation(
            a.messages,
            a.summary,
            a.tags ?? [],
          );
          return {
            content: [
              {
                type: 'text',
                text: `Saved conversation at: ${note.path}`,
              },
            ],
          };
        }

        case 'skill_store': {
          const a = args as { slug: string; content: string; tags?: string[] };
          const note = await manager.storeSkill(a.slug, a.content, a.tags ?? []);
          return {
            content: [{ type: 'text', text: `Stored skill at: ${note.path}` }],
          };
        }

        case 'skill_get': {
          const a = args as { slug: string };
          const note = await manager.getSkill(a.slug);
          if (!note) {
            return {
              content: [{ type: 'text', text: `Skill not found: ${a.slug}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: note.serialize() }],
          };
        }

        case 'skill_list': {
          const notes = await manager.listSkills();
          const results = notes.map((n) => ({
            slug: n.path.split('/').pop()?.replace(/\.md$/, '') ?? n.path,
            tags: n.frontmatter.tags ?? [],
            updated: n.frontmatter.updated,
            preview: n.content.slice(0, 120),
          }));
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          };
        }

        case 'scratch_append': {
          const a = args as { content: string };
          await manager.appendScratch(SESSION_ID, a.content);
          return {
            content: [{ type: 'text', text: `Appended to scratch log.` }],
          };
        }

        case 'scratch_read': {
          const a = args as { session_id?: string; limit?: number; since?: string };
          const entries = await manager.readScratch({
            sessionId: a.session_id,
            limit: a.limit,
            since: a.since,
          });
          if (entries.length === 0) {
            return {
              content: [{ type: 'text', text: 'Scratch log is empty.' }],
            };
          }
          const text = entries
            .map((e) => `[${e.sessionId} | ${e.timestamp}] ${e.content}`)
            .join('\n');
          return {
            content: [{ type: 'text', text: text }],
          };
        }

        case 'scratch_compact': {
          const a = args as { session_id: string; threshold_hours?: number; compacted_content: string };
          const thresholdMs = (a.threshold_hours ?? 1) * 60 * 60 * 1000;
          await manager.compactScratch({
            sessionId: a.session_id,
            thresholdMs,
            compactedContent: a.compacted_content,
          });
          return {
            content: [{ type: 'text', text: `Compacted scratch entries for session ${a.session_id}.` }],
          };
        }

        case 'memory_archive_forgotten': {
          const a = args as { older_than_days?: number };
          const archived = await manager.archiveForgotten(a.older_than_days);
          const msg = archived.length > 0
            ? `Archived ${archived.length} forgotten note(s):\n${archived.join('\n')}`
            : 'No forgotten notes matched the criteria.';
          return { content: [{ type: 'text', text: msg }] };
        }

        case 'scratch_clear': {
          await manager.clearScratch();
          return {
            content: [{ type: 'text', text: 'Cleared scratch log.' }],
          };
        }

        case 'thread_get': {
          const a = args as { thread_id: string };
          const thread = await manager.getThread(a.thread_id);
          if (!thread) {
            return {
              content: [{ type: 'text', text: `Thread not found: ${a.thread_id}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: thread.serialize() }],
          };
        }

        case 'thread_set': {
          const a = args as {
            thread_id: string;
            content: string;
            name?: string;
            description?: string;
            status?: 'active' | 'paused' | 'closed';
            goals?: string[];
            paths?: string[];
            related_threads?: string[];
            tags?: string[];
          };
          const statusMap: Record<string, ThreadStatus> = {
            active: ThreadStatus.Active,
            paused: ThreadStatus.Paused,
            closed: ThreadStatus.Closed,
          };
          const thread = await manager.setThread(a.thread_id, a.content, {
            name: a.name,
            description: a.description,
            status: a.status ? statusMap[a.status] : undefined,
            goals: a.goals,
            paths: a.paths,
            related_threads: a.related_threads,
            tags: a.tags,
          });
          return {
            content: [{ type: 'text', text: `Thread written to: ${thread.path}` }],
          };
        }

        case 'thread_update': {
          const a = args as {
            thread_id: string;
            content?: string;
            name?: string;
            description?: string;
            status?: 'active' | 'paused' | 'closed';
            goals?: string[];
            paths?: string[];
            related_threads?: string[];
            tags?: string[];
          };
          const statusMap: Record<string, ThreadStatus> = {
            active: ThreadStatus.Active,
            paused: ThreadStatus.Paused,
            closed: ThreadStatus.Closed,
          };
          const thread = await manager.updateThread(a.thread_id, a.content, {
            name: a.name,
            description: a.description,
            status: a.status ? statusMap[a.status] : undefined,
            goals: a.goals,
            paths: a.paths,
            related_threads: a.related_threads,
            tags: a.tags,
          });
          return {
            content: [{ type: 'text', text: `Thread updated at: ${thread.path}` }],
          };
        }

        case 'thread_list': {
          const threads = await manager.listThreads();
          const results = threads.map((t) => ({
            thread_id: t.frontmatter.thread_id,
            name: t.frontmatter.name,
            status: t.frontmatter.status,
            description: t.frontmatter.description,
            goals: t.frontmatter.goals ?? [],
            paths: t.frontmatter.paths ?? [],
            related_threads: t.frontmatter.related_threads ?? [],
            updated: t.frontmatter.updated,
          }));
          return {
            content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
          };
        }

        case 'thread_resolve': {
          const a = args as { cwd?: string; git_remote?: string; auto_create?: boolean };
          const result = await manager.resolveThread({
            cwd: a.cwd,
            gitRemote: a.git_remote,
            autoCreate: a.auto_create,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    thread_id: result.threadId,
                    status: result.created ? 'created' : 'found',
                    thread: result.thread.serialize(),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        case 'thread_merge': {
          const a = args as { source_thread_id: string; target_thread_id: string };
          const result = await manager.mergeThreads(a.source_thread_id, a.target_thread_id);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    source_thread_id: a.source_thread_id,
                    target_thread_id: a.target_thread_id,
                    retagged_count: result.retaggedCount,
                    source_status: 'closed',
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
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
