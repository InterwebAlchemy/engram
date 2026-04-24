#!/usr/bin/env node
/**
 * @interwebalchemy/engram-mcp
 *
 * Usage:
 *   npx @interwebalchemy/engram-mcp --vault /path/to/vault [options]
 *
 * Options:
 *   --vault <path>              Path to Obsidian vault (required)
 *   --mode  integrated|standalone   Vault mode (default: integrated)
 *   --engram-root <dir>         Engram subdirectory (default: engram)
 *   --read-paths <a,b,c>        Comma-separated dirs the assistant may read beyond engram root
 *   --transport stdio|http      Transport mode (default: stdio)
 *   --port <number>             HTTP port when --transport http (default: 3100)
 *
 * Claude Desktop config example:
 *   {
 *     "mcpServers": {
 *       "engram": {
 *         "command": "npx",
 *         "args": ["-y", "@interwebalchemy/engram-mcp", "--vault", "/path/to/vault"]
 *       }
 *     }
 *   }
 */

import { startServer } from './server.js';

const FLAG_PREFIX = '--';
const NEXT_ARG_OFFSET = 1;
const CLI_ARG_START_INDEX = 2;

function parseArgs(argv: string[]): Partial<Record<string, string>> {
  const result: Partial<Record<string, string>> = {};
  let index = 0;

  while (index < argv.length) {
    const arg = argv.at(index);
    if (arg?.startsWith(FLAG_PREFIX) === true) {
      const key = arg.slice(FLAG_PREFIX.length);
      const valueIndex = index + NEXT_ARG_OFFSET;
      const value = argv.at(valueIndex);
      if (value !== undefined && !value.startsWith(FLAG_PREFIX)) {
        result[key] = value;
        index = valueIndex;
      }
    }

    index += NEXT_ARG_OFFSET;
  }

  return result;
}

function parseMode(value: string | undefined): 'integrated' | 'standalone' {
  return value === 'standalone' ? 'standalone' : 'integrated';
}

function parseTransport(value: string | undefined): 'stdio' | 'http' {
  return value === 'http' ? 'http' : 'stdio';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(CLI_ARG_START_INDEX));

  const { vault: vaultPath } = args;
  if (vaultPath === undefined || vaultPath.length === 0) {
    process.stderr.write('Error: --vault <path> is required\n');
    process.stderr.write('Usage: engram-mcp --vault /path/to/vault [--mode integrated|standalone]\n');
    process.exit(1);
  }

  const mode = parseMode(args.mode);
  const {
    'engram-root': engramRoot,
    'read-paths': readPathsArg,
    port: portValue,
    transport: transportValue,
  } = args;
  const readPaths = readPathsArg === undefined || readPathsArg.length === 0
    ? []
    : readPathsArg
      .split(',')
      .map((path) => path.trim())
      .filter((path) => path.length > 0);
  const transport = parseTransport(transportValue);
  const port = portValue === undefined || portValue.length === 0
    ? undefined
    : parseInt(portValue, 10);

  try {
    await startServer({ vaultPath, mode, engramRoot, readPaths, transport, port });
  } catch (err) {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

void main();
