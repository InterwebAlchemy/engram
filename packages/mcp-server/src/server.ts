import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  MemoryManager,
  NodeAdapter,
  defaultMemoryConfig,
} from '@interwebalchemy/engram-core';
import type { MemoryConfig } from '@interwebalchemy/engram-core';
import { registerTools } from './tools';

const HTTP_METHOD_OPTIONS = 'OPTIONS';
const HTTP_METHOD_GET = 'GET';
const HTTP_METHOD_POST = 'POST';
const HTTP_METHOD_DELETE = 'DELETE';
const HTTP_STATUS_NO_CONTENT = 204;
const HTTP_STATUS_OK = 200;
const HTTP_STATUS_BAD_REQUEST = 400;
const HTTP_STATUS_NOT_FOUND = 404;
const LOCALHOST = '127.0.0.1';
const HEALTH_PATH = '/health';
const MCP_PATH = '/mcp';
const DEFAULT_PORT = 0;

interface StreamableTransportLike {
  handleRequest: (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<void>;
  sessionId?: string;
  onclose?: () => void;
}

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
  const mode = cfg.mode ?? 'integrated';
  const { engramRoot } = cfg;
  const memoryConfig: MemoryConfig = {
    ...defaultMemoryConfig(cfg.vaultPath, mode),
    ...(engramRoot === undefined || engramRoot.length === 0 ? {} : { engramRoot }),
    readPaths: cfg.readPaths ?? [],
  };

  const adapter = new NodeAdapter();
  const manager = new MemoryManager(adapter, memoryConfig);

  if (cfg.transport === 'http') {
    const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
    const requestedPort = cfg.port ?? DEFAULT_PORT;

    // Stateful mode: one Server+Transport pair per session, keyed by Mcp-Session-Id.
    // The initialize request creates a session; all subsequent requests must include
    // the session ID header. Sessions are cleaned up when the transport closes.
    const sessions = new Map<string, StreamableTransportLike>();

    const createSession = async (): Promise<StreamableTransportLike> => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- Low-level Server is still needed for the current transport/session wiring.
      const server = new Server(
        { name: 'engram', version: '0.1.0' },
        { capabilities: { tools: {}, resources: {} } },
      );
      registerTools(server, manager);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const { sessionId } = transport;
        if (sessionId !== undefined && sessionId.length > 0) {
          sessions.delete(sessionId);
        }
      };

      await server.connect(transport);
      return transport;
    };

    const httpServer = createServer((req, res) => {
      void handleHttpRequest({
        createSession,
        req,
        res,
        sessions,
        vaultPath: cfg.vaultPath,
      }).catch((error: unknown) => {
        res.writeHead(HTTP_STATUS_BAD_REQUEST, { 'Content-Type': 'text/plain' });
        res.end(error instanceof Error ? error.message : String(error));
      });
    });

    httpServer.listen(requestedPort, LOCALHOST);
    await once(httpServer, 'listening');

    const boundPort = resolveBoundPort(httpServer.address());

    process.stderr.write(
      `Engram MCP server started — http://${LOCALHOST}:${boundPort}${MCP_PATH}\n` +
      `  vault: ${cfg.vaultPath} (${mode} mode)\n`,
    );
  } else {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- Low-level Server is still needed for the stdio transport path.
    const server = new Server(
      { name: 'engram', version: '0.1.0' },
      { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(server, manager);

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Log to stderr so it doesn't pollute stdio transport
    process.stderr.write(
      `Engram MCP server started — vault: ${cfg.vaultPath} (${mode} mode)\n`,
    );
  }
}

async function handleHttpRequest(options: {
  readonly createSession: () => Promise<StreamableTransportLike>;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly sessions: Map<string, StreamableTransportLike>;
  readonly vaultPath: string;
}): Promise<void> {
  const {
    createSession,
    req,
    res,
    sessions,
    vaultPath,
  } = options;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

  const { method } = req;
  if (handleOptionsRequest(method, res)) {
    return;
  }

  const { url } = req;
  if (handleHealthRequest(url, method, vaultPath, res)) {
    return;
  }

  if (url !== MCP_PATH || !isAllowedHttpMethod(method)) {
    res.writeHead(HTTP_STATUS_NOT_FOUND);
    res.end();
    return;
  }

  const sessionId = readSessionId(req.headers['mcp-session-id']);
  if (sessionId !== undefined && sessionId.length > 0) {
    await handleExistingSession(sessionId, sessions, req, res);
    return;
  }

  if (method !== HTTP_METHOD_POST) {
    res.writeHead(HTTP_STATUS_BAD_REQUEST, { 'Content-Type': 'text/plain' });
    res.end('Missing Mcp-Session-Id header');
    return;
  }

  const transport = await createSession();
  await transport.handleRequest(req, res);
  const { sessionId: createdSessionId } = transport;
  if (createdSessionId !== undefined && createdSessionId.length > 0) {
    sessions.set(createdSessionId, transport);
  }
}

function handleOptionsRequest(method: string | undefined, res: ServerResponse): boolean {
  if (method !== HTTP_METHOD_OPTIONS) {
    return false;
  }

  res.writeHead(HTTP_STATUS_NO_CONTENT);
  res.end();
  return true;
}

function handleHealthRequest(
  url: string | undefined,
  method: string | undefined,
  vaultPath: string,
  res: ServerResponse,
): boolean {
  if (url !== HEALTH_PATH || method !== HTTP_METHOD_GET) {
    return false;
  }

  res.writeHead(HTTP_STATUS_OK, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', vault: vaultPath }));
  return true;
}

async function handleExistingSession(
  sessionId: string,
  sessions: Map<string, StreamableTransportLike>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const transport = sessions.get(sessionId);
  if (transport === undefined) {
    res.writeHead(HTTP_STATUS_NOT_FOUND, { 'Content-Type': 'text/plain' });
    res.end('Session not found');
    return;
  }

  await transport.handleRequest(req, res);
}

function isAllowedHttpMethod(method: string | undefined): boolean {
  return method === HTTP_METHOD_GET || method === HTTP_METHOD_POST || method === HTTP_METHOD_DELETE;
}

function readSessionId(header: string | string[] | undefined): string | undefined {
  if (typeof header === 'string') {
    return header;
  }
  if (Array.isArray(header)) {
    const [firstHeader] = header;
    return firstHeader;
  }
  return undefined;
}

function resolveBoundPort(address: ReturnType<ReturnType<typeof createServer>['address']>): number {
  if (address === null || typeof address === 'string') {
    throw new Error('HTTP server did not report a numeric bound port.');
  }

  return address.port;
}
