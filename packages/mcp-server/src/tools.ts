import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { MemoryManager } from '@interwebalchemy/engram-core';
import { TOOLS } from './tool-definitions';
import {
  formatUnknown,
  textResult,
  toolArgs,
  type ToolArgs,
  type ToolResponse,
} from './tool-args';
import {
  handleContextTool,
  handleConversationTool,
  handleMemoryTool,
  handleNoteTool,
  handleScratchTool,
  handleSkillTool,
  handleSoulTool,
} from './tool-memory-handlers';
import {
  handleInboxTool,
  handleThreadTool,
} from './tool-thread-handlers';

type ToolHandler = (manager: MemoryManager, args: ToolArgs) => Promise<ToolResponse>;

const TOOL_HANDLERS = {
  memory: handleMemoryTool,
  soul: handleSoulTool,
  context: handleContextTool,
  note: handleNoteTool,
  conversation: handleConversationTool,
  skill: handleSkillTool,
  scratch: handleScratchTool,
  thread: handleThreadTool,
  inbox: handleInboxTool,
} as const satisfies Record<string, ToolHandler>;

export function registerTools(server: Server, manager: MemoryManager): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await Promise.resolve();
    return { tools: TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, _extra): Promise<ToolResponse> => {
    const { params } = request;
    const {
      name,
      arguments: rawArgs,
    } = params;
    const handler = getToolHandler(name);
    if (handler === undefined) {
      return textResult(`Unknown tool: ${name}`, true);
    }

    try {
      return await handler(manager, toolArgs(rawArgs));
    } catch (error) {
      return textResult(`Error: ${formatUnknown(error)}`, true);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const soul = await manager.getSoulDocument();
    return {
      resources: soul === null
        ? []
        : [
            {
              uri: 'engram://soul',
              name: 'Soul Document',
              description: 'Persistent identity and self-model for this agent. Read at session start.',
              mimeType: 'text/markdown',
            },
          ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { params } = request;
    const { uri } = params;
    if (uri !== 'engram://soul') {
      throw new Error(`Unknown resource: ${uri}`);
    }

    const soul = await manager.getSoulDocument();
    if (soul === null) {
      throw new Error('Soul document not found.');
    }
    const { content } = soul;

    return {
      contents: [
        {
          uri,
          mimeType: 'text/markdown',
          text: content,
        },
      ],
    };
  });
}

function getToolHandler(name: string): ToolHandler | undefined {
  if (name === 'memory') {
    return TOOL_HANDLERS.memory;
  }
  if (name === 'soul') {
    return TOOL_HANDLERS.soul;
  }
  if (name === 'context') {
    return TOOL_HANDLERS.context;
  }
  if (name === 'note') {
    return TOOL_HANDLERS.note;
  }
  if (name === 'conversation') {
    return TOOL_HANDLERS.conversation;
  }
  if (name === 'skill') {
    return TOOL_HANDLERS.skill;
  }
  if (name === 'scratch') {
    return TOOL_HANDLERS.scratch;
  }
  if (name === 'thread') {
    return TOOL_HANDLERS.thread;
  }
  if (name === 'inbox') {
    return TOOL_HANDLERS.inbox;
  }
  return undefined;
}
