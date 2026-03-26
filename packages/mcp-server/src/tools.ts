import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
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
    name: 'memory_update',
    description: 'Update an existing memory note\'s content, tags, or memory state.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the memory note.' },
        content: { type: 'string', description: 'New content (replaces existing).' },
        tags: { type: 'array', items: { type: 'string' }, description: 'New tag list.' },
        state: {
          type: 'string',
          enum: ['core', 'remembered', 'default', 'forgotten'],
          description: 'New memory state.',
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
          });
          const results = notes.map((n) => ({
            path: n.path,
            type: n.frontmatter.type,
            state: n.frontmatter.memory_state,
            tags: n.frontmatter.tags ?? [],
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

        case 'memory_update': {
          const a = args as {
            path: string;
            content?: string;
            tags?: string[];
            state?: 'core' | 'remembered' | 'default' | 'forgotten';
          };
          const stateMap: Record<string, MemoryState> = {
            core: MemoryState.Core,
            remembered: MemoryState.Remembered,
            default: MemoryState.Default,
            forgotten: MemoryState.Forgotten,
          };
          const fmUpdates: Record<string, unknown> = {};
          if (a.tags !== undefined) fmUpdates.tags = a.tags;
          if (a.state !== undefined) fmUpdates.memory_state = stateMap[a.state];

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
          });
          const results = notes.map((n) => ({
            path: n.path,
            type: n.frontmatter.type,
            state: n.frontmatter.memory_state,
            tags: n.frontmatter.tags ?? [],
            created: n.frontmatter.created,
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
}
