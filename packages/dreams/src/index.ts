#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import { runDreams } from './runner';
import type { DreamsFocus, DreamsRunnerOptions } from './types';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const vaultPath = await resolveVaultPath(args.vault);

  const options: DreamsRunnerOptions = {
    vaultPath,
    provider: args.provider,
    model: args.model,
    apiKey: args.apiKey,
    baseURL: args.baseURL,
    dryRun: args.dryRun,
    focus: args.focus,
  };

  const result = await runDreams(options);

  console.log(`Dreams report timestamp: ${result.report.timestamp}`);
  console.log(`Vault: ${vaultPath}`);
  console.log(`Provider: ${options.provider}`);
  console.log(`Model: ${options.model}`);
  console.log(`Actions proposed: ${result.actions.length}`);
  console.log(`Execution mode: ${result.execution.dryRun ? 'dry-run' : 'apply'}`);
  if (result.usage) {
    console.log(
      `Token usage: ${result.usage.total_tokens} total (${result.usage.prompt_tokens} prompt, ${result.usage.completion_tokens} completion)`,
    );
  }

  if (result.actions.length > 0) {
    console.log('');
    console.log('Actions:');
    for (const detail of result.execution.details) {
      console.log(`- ${detail}`);
    }
  }

  if (result.actions.length === 0) {
    console.log('');
    console.log('No actions proposed.');
  }
}

interface ParsedArgs {
  vault?: string;
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey?: string;
  baseURL?: string;
  dryRun: boolean;
  focus?: DreamsFocus[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    provider: (process.env.ENGRAM_DREAMS_PROVIDER as 'anthropic' | 'openai' | undefined) ?? 'anthropic',
    model: process.env.ENGRAM_DREAMS_MODEL ?? DEFAULT_MODEL,
    apiKey: process.env.ENGRAM_DREAMS_API_KEY,
    baseURL: process.env.ENGRAM_DREAMS_BASE_URL,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    switch (arg) {
      case '--vault':
        parsed.vault = argv[++i];
        break;
      case '--provider':
        parsed.provider = normalizeProvider(argv[++i]);
        break;
      case '--model':
        parsed.model = argv[++i] ?? parsed.model;
        break;
      case '--api-key':
        parsed.apiKey = argv[++i];
        break;
      case '--base-url':
        parsed.baseURL = argv[++i];
        break;
      case '--focus':
        parsed.focus = (argv[++i] ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean) as DreamsFocus[];
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function normalizeProvider(value: string | undefined): 'anthropic' | 'openai' {
  if (value === 'openai' || value === 'openai-compat') return 'openai';
  return 'anthropic';
}

async function resolveVaultPath(cliVault?: string): Promise<string> {
  if (cliVault) return expandHome(cliVault);
  if (process.env.ENGRAM_VAULT_PATH) return expandHome(process.env.ENGRAM_VAULT_PATH);

  const repoRoot = path.resolve(__dirname, '../../..');
  const envPath = path.join(repoRoot, '.env');

  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.startsWith('ENGRAM_VAULT_PATH=')) continue;
      const value = line.slice('ENGRAM_VAULT_PATH='.length).trim();
      if (value.length > 0) return expandHome(stripQuotes(value));
    }
  } catch {
    // Fall through to the default dev vault path.
  }

  return path.join(repoRoot, 'tmp', 'vault');
}

function expandHome(value: string): string {
  return value.startsWith('~') ? path.join(process.env.HOME ?? '', value.slice(1)) : value;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

function printHelp(): void {
  console.log('Usage: engram-dreams --vault <path> [--provider anthropic|openai] [--model <id>] [--api-key <key>] [--base-url <url>] [--dry-run]');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Dreams failed: ${message}`);
  process.exit(1);
});
