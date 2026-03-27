import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  MemoryManager,
  NodeAdapter,
  defaultMemoryConfig,
} from '@interwebalchemy/engram-core';
import type { MemoryConfig } from '@interwebalchemy/engram-core';
import { registerTools } from './tools';

export interface ServerConfig {
  vaultPath: string;
  mode?: 'integrated' | 'standalone';
  engramRoot?: string;
  readPaths?: string[];
  maxSearchResults?: number;
}

export async function startServer(cfg: ServerConfig): Promise<void> {
  const memoryConfig: MemoryConfig = {
    ...defaultMemoryConfig(cfg.vaultPath, cfg.mode ?? 'integrated'),
    ...(cfg.engramRoot ? { engramRoot: cfg.engramRoot } : {}),
    readPaths: cfg.readPaths ?? [],
  };

  const adapter = new NodeAdapter();
  const manager = new MemoryManager(adapter, memoryConfig);

  const server = new Server(
    { name: 'engram', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  registerTools(server, manager);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so it doesn't pollute stdio transport
  process.stderr.write(
    `Engram MCP server started — vault: ${cfg.vaultPath} (${cfg.mode ?? 'integrated'} mode)\n`,
  );
}
