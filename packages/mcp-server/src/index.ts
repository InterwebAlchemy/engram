#!/usr/bin/env node
/**
 * @interwebalchemy/engram-mcp
 *
 * Usage:
 *   npx @interwebalchemy/engram-mcp --vault /path/to/vault [options]
 *
 * Options:
 *   --vault <path>          Path to Obsidian vault (required)
 *   --mode  integrated|standalone   Vault mode (default: integrated)
 *   --engram-root <dir>     Engram subdirectory (default: engram)
 *   --read-paths <a,b,c>    Comma-separated dirs the assistant may read beyond engram root
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

import { startServer } from './server';

function parseArgs(argv: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        result[key] = value;
        i++;
      }
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const vaultPath = args['vault'];
  if (!vaultPath) {
    process.stderr.write('Error: --vault <path> is required\n');
    process.stderr.write('Usage: engram-mcp --vault /path/to/vault [--mode integrated|standalone]\n');
    process.exit(1);
  }

  const mode = (args['mode'] as 'integrated' | 'standalone') ?? 'integrated';
  const engramRoot = args['engram-root'];
  const readPaths = args['read-paths']
    ? args['read-paths'].split(',').map((p) => p.trim()).filter(Boolean)
    : [];

  try {
    await startServer({ vaultPath, mode, engramRoot, readPaths });
  } catch (err) {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

main();
