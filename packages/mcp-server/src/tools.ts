import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import {
  TOOLS,
  executeToolCall,
  type MemoryManager,
  type ToolResponse,
} from '@interwebalchemy/engram-core';

// eslint-disable-next-line @typescript-eslint/no-deprecated -- Tool registration still targets the low-level MCP Server API used by current transports.
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
    return await executeToolCall({ manager, name, args: rawArgs });
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
