import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { MemoryManager, MemoryType, MemoryState } from '@interwebalchemy/engram-core';

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
        summary: {
          type: 'string',
          description: 'Short bullet-point summary (2-5 lines) for token-efficient context loading. When present, get_context loads this instead of full content for non-core memories. Write it as the key facts you would want surfaced during a future session start.',
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
    description: 'Read the current Soul document. Returns null if none exists yet.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_context',
    description:
      'Load the full agent context for the current session: Soul document, core memories, and memories relevant to the given query. ' +
      'Call this at the start of a session to restore identity and relevant history.',
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
        summary: {
          type: 'string',
          description: 'Updated short bullet-point summary for token-efficient context loading.',
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
    name: 'scratch_write',
    description:
      'Write to the ephemeral scratchpad. Use this for temporary working notes during a task — ' +
      'planning steps, tracking findings, or staging content before committing it to memory. ' +
      'Scratch notes are never injected into context and should be cleared when the task is done.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'Short identifier for this scratch note (e.g. "current-investigation").',
        },
        content: { type: 'string', description: 'The scratch content.' },
      },
      required: ['key', 'content'],
    },
  },
  {
    name: 'scratch_read',
    description: 'Read a scratch note by key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'The scratch key to read.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'scratch_list',
    description: 'List all current scratch keys.',
    inputSchema: { type: 'object', properties: {} },
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
      'Permanently delete scratch notes — this is a hard delete with no archiving. ' +
      'If a key is provided, only that note is deleted. ' +
      'If no key is provided, all scratch notes are deleted. ' +
      'Call this at the end of a task to keep the scratchpad tidy.',
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          description: 'The key to clear. Omit to clear all scratch notes.',
        },
      },
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
            bootstrap_state?: 'full' | 'partial' | 'none';
            agent?: string;
            platform?: string;
            summary?: string;
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
          if (a.bootstrap_state !== undefined) metaUpdates.bootstrap_state = a.bootstrap_state;
          if (a.agent !== undefined) metaUpdates.agent = a.agent;
          if (a.platform !== undefined) metaUpdates.platform = a.platform;
          if (a.summary !== undefined) metaUpdates.summary = a.summary;
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
          return {
            content: [
              {
                type: 'text',
                text: soul ? soul.serialize() : 'No Soul document found.',
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
          const a = args as { query: string; token_budget?: number };
          const budget = { max: a.token_budget ?? 6000 };
          const sections = await manager.getContext(a.query, budget);
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
            'Active scratch discipline — do these throughout the session:',
            '- **Task start**: `scratch_write("current-task", goal + approach)`',
            '- **Each significant milestone** (decision made, file changed, build passed): append to `scratch_write("session-log", ...)`',
            '- **Reasoning trace**: `scratch_write("thoughts", "I\'m considering X because Y")` when weighing tradeoffs',
            '- **Before wrapping a response** that feels like a natural stopping point: verify scratch reflects current state',
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
            bootstrap_state?: 'full' | 'partial' | 'none';
            agent?: string;
            platform?: string;
            summary?: string;
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
          if (a.bootstrap_state !== undefined) fmUpdates.bootstrap_state = a.bootstrap_state;
          if (a.agent !== undefined) fmUpdates.agent = a.agent;
          if (a.platform !== undefined) fmUpdates.platform = a.platform;
          if (a.summary !== undefined) fmUpdates.summary = a.summary;

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

        case 'scratch_write': {
          const a = args as { key: string; content: string };
          const note = await manager.writeScratch(a.key, a.content);
          return {
            content: [{ type: 'text', text: `Wrote scratch note: ${note.path}` }],
          };
        }

        case 'scratch_read': {
          const a = args as { key: string };
          const note = await manager.readScratch(a.key);
          if (!note) {
            return {
              content: [{ type: 'text', text: `Scratch note not found: ${a.key}` }],
              isError: true,
            };
          }
          return {
            content: [{ type: 'text', text: note.serialize() }],
          };
        }

        case 'scratch_list': {
          const keys = await manager.listScratch();
          return {
            content: [{ type: 'text', text: JSON.stringify(keys, null, 2) }],
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
          const a = args as { key?: string };
          await manager.clearScratch(a.key);
          const msg = a.key ? `Cleared scratch note: ${a.key}` : 'Cleared all scratch notes.';
          return {
            content: [{ type: 'text', text: msg }],
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
