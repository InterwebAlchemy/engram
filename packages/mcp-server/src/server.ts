import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
  transport?: 'stdio' | 'http';
  port?: number;
}

export async function startServer(cfg: ServerConfig): Promise<void> {
  const memoryConfig: MemoryConfig = {
    ...defaultMemoryConfig(cfg.vaultPath, cfg.mode ?? 'integrated'),
    ...(cfg.engramRoot ? { engramRoot: cfg.engramRoot } : {}),
    readPaths: cfg.readPaths ?? [],
  };

  const adapter = new NodeAdapter();
  const manager = new MemoryManager(adapter, memoryConfig);

  if (cfg.transport === 'http') {
    const requestedPort = cfg.port ?? 0;

    // Stateful mode: one Server+Transport pair per session, keyed by Mcp-Session-Id.
    // The initialize request creates a session; all subsequent requests must include
    // the session ID header. Sessions are cleaned up when the transport closes.
    const sessions = new Map<string, StreamableHTTPServerTransport>();

    const createSession = async (): Promise<StreamableHTTPServerTransport> => {
      const server = new Server(
        { name: 'engram', version: '0.1.0' },
        { capabilities: { tools: {}, resources: {} } },
      );
      registerTools(server, manager);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };

      await server.connect(transport);
      return transport;
    };

    const httpServer = createServer(async (req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', vault: cfg.vaultPath }));
        return;
      }

      if (req.url !== '/mcp' || !['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
        res.writeHead(404);
        res.end();
        return;
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        // Route to existing session
        const transport = sessions.get(sessionId);
        if (!transport) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Session not found');
          return;
        }
        await transport.handleRequest(req, res);
      } else if (req.method === 'POST') {
        // New session — initialize creates it
        const transport = await createSession();
        await transport.handleRequest(req, res);
        if (transport.sessionId) sessions.set(transport.sessionId, transport);
      } else {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing Mcp-Session-Id header');
      }
    });

    await new Promise<void>((resolve) => httpServer.listen(requestedPort, '127.0.0.1', resolve));

    const { port: boundPort } = httpServer.address() as { port: number };

    process.stderr.write(
      `Engram MCP server started — http://127.0.0.1:${boundPort}/mcp\n` +
      `  vault: ${cfg.vaultPath} (${cfg.mode ?? 'integrated'} mode)\n`,
    );
  } else {
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
}
