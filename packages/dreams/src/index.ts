#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  argv,
  env,
  exit,
  stderr,
  stdout,
} from 'node:process';
import { runDreams, runDreamsCleanup } from './runner';
import type { DreamsFocus, DreamsRunnerOptions } from './types';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const CLI_ARG_START_INDEX = 2;
const REPO_ROOT_SEGMENTS_UP = '../../..';
const DEFAULT_ENGRAM_ROOT = 'engram';
const DEFAULT_PROVIDER = 'anthropic';
const PATH_LIST_SEPARATOR = ',';
const CARRIAGE_RETURN_PATTERN = /\r?\n/gu;
const WRAPPED_QUOTES_PATTERN = /^['"]|['"]$/gu;
const BACKSLASH_PATTERN = /\\/gu;

function writeLine(message = ''): void {
  stdout.write(`${message}\n`);
}

function writeError(message: string): void {
  stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(CLI_ARG_START_INDEX));
  const vaultPath = await resolveVaultPath(args.vault);
  const engramRoot = await resolveEngramRoot(args.engramRoot);

  const options: DreamsRunnerOptions = {
    vaultPath,
    engramRoot,
    provider: args.provider,
    model: args.model,
    apiKey: args.apiKey,
    baseURL: args.baseURL,
    dryRun: args.dryRun,
    focus: args.focus,
  };

  if (args.cleanupOnly) {
    const result = await runDreamsCleanup({
      vaultPath,
      engramRoot,
      focus: args.focus,
    });

    writeLine(`Dreams cleanup timestamp: ${result.report.timestamp}`);
    writeLine(`Vault: ${vaultPath}`);
    writeLine(
      `Pre-cleanup: ${result.preCleanup.tagsFixed} tags fixed, ${result.preCleanup.tagsNormalized} tags normalized, ${result.preCleanup.scratchEntriesPurged} scratch entries purged, ${result.preCleanup.orphanedDreamStartsResolved} orphaned dream starts resolved`,
    );
    writeLine(`Scratch entries remaining: ${result.report.scratchHealth.entryCount}`);
    writeLine(`Scratch stale sessions remaining: ${result.report.scratchHealth.staleSessions.length}`);
    writeLine(`Thread pressure: ${result.report.threadHealth.oversizedThreads.length} oversized, ${result.report.threadHealth.staleThreads.length} stale`);
    return;
  }

  const result = await runDreams(options);

  writeLine(`Dreams report timestamp: ${result.report.timestamp}`);
  writeLine(`Vault: ${vaultPath}`);
  writeLine(`Provider: ${options.provider}`);
  writeLine(`Model: ${options.model}`);
  writeLine(`Actions proposed: ${result.actions.length}`);
  writeLine(`Execution mode: ${result.execution.dryRun ? 'dry-run' : 'apply'}`);
  if (result.usage !== undefined) {
    writeLine(
      `Token usage: ${result.usage.total_tokens} total (${result.usage.prompt_tokens} prompt, ${result.usage.completion_tokens} completion)`,
    );
  }

  if (result.actions.length > 0) {
    writeLine();
    writeLine('Actions:');
    for (const detail of result.execution.details) {
      writeLine(`- ${detail}`);
    }
  }

  if (result.actions.length === 0) {
    writeLine();
    writeLine('No actions proposed.');
  }
}

interface ParsedArgs {
  vault?: string;
  engramRoot?: string;
  provider: 'anthropic' | 'openai';
  model: string;
  apiKey?: string;
  baseURL?: string;
  dryRun: boolean;
  cleanupOnly: boolean;
  focus?: DreamsFocus[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    provider: normalizeProvider(env.ENGRAM_DREAMS_PROVIDER),
    model: env.ENGRAM_DREAMS_MODEL ?? DEFAULT_MODEL,
    apiKey: env.ENGRAM_DREAMS_API_KEY,
    baseURL: env.ENGRAM_DREAMS_BASE_URL,
    dryRun: false,
    cleanupOnly: false,
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv.at(index);
    switch (arg) {
      case '--vault':
        index += 1;
        parsed.vault = argv.at(index);
        break;
      case '--provider':
        index += 1;
        parsed.provider = normalizeProvider(argv.at(index));
        break;
      case '--engram-root':
        index += 1;
        parsed.engramRoot = argv.at(index);
        break;
      case '--model':
        index += 1;
        parsed.model = argv.at(index) ?? parsed.model;
        break;
      case '--api-key':
        index += 1;
        parsed.apiKey = argv.at(index);
        break;
      case '--base-url':
        index += 1;
        parsed.baseURL = argv.at(index);
        break;
      case '--focus':
        index += 1;
        parsed.focus = parseFocusList(argv.at(index));
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      case '--cleanup-only':
        parsed.cleanupOnly = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        exit(0);
        return parsed;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }

  return parsed;
}

function normalizeProvider(value: string | undefined): 'anthropic' | 'openai' {
  if (value === 'openai' || value === 'openai-compat') return 'openai';
  return DEFAULT_PROVIDER;
}

async function resolveVaultPath(cliVault?: string): Promise<string> {
  if (typeof cliVault === 'string' && cliVault.length > 0) return expandHome(cliVault);
  if (typeof env.ENGRAM_VAULT_PATH === 'string' && env.ENGRAM_VAULT_PATH.length > 0) {
    return expandHome(env.ENGRAM_VAULT_PATH);
  }

  const repoRoot = path.resolve(__dirname, REPO_ROOT_SEGMENTS_UP);
  const envPath = path.join(repoRoot, '.env');

  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split(CARRIAGE_RETURN_PATTERN)) {
      if (!line.startsWith('ENGRAM_VAULT_PATH=')) continue;
      const value = line.slice('ENGRAM_VAULT_PATH='.length).trim();
      if (value.length > 0) return expandHome(stripQuotes(value));
    }
  } catch {
    // Fall through to the default dev vault path.
  }

  return path.join(repoRoot, 'tmp', 'vault');
}

async function resolveEngramRoot(cliEngramRoot?: string): Promise<string | undefined> {
  if (typeof cliEngramRoot === 'string' && cliEngramRoot.length > 0) return normalizeEngramRoot(cliEngramRoot);
  if (typeof env.ENGRAM_ROOT === 'string' && env.ENGRAM_ROOT.length > 0) {
    return normalizeEngramRoot(env.ENGRAM_ROOT);
  }

  const repoRoot = path.resolve(__dirname, REPO_ROOT_SEGMENTS_UP);
  const envPath = path.join(repoRoot, '.env');

  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split(CARRIAGE_RETURN_PATTERN)) {
      if (!line.startsWith('ENGRAM_ROOT=')) continue;
      const value = line.slice('ENGRAM_ROOT='.length).trim();
      if (value.length > 0) return normalizeEngramRoot(stripQuotes(value));
    }
  } catch {
    // Default to the runtime's built-in Engram root.
  }

  return undefined;
}

function expandHome(value: string): string {
  return value.startsWith('~') ? path.join(env.HOME ?? '', value.slice(1)) : value;
}

function stripQuotes(value: string): string {
  return value.replace(WRAPPED_QUOTES_PATTERN, '');
}

function normalizeEngramRoot(value: string): string {
  const normalized = value.replace(BACKSLASH_PATTERN, '/').replace(/^\/+|\/+$/gu, '');
  return normalized.length > 0 ? normalized : DEFAULT_ENGRAM_ROOT;
}

function printHelp(): void {
  writeLine('Usage: engram-dreams --vault <path> [--engram-root <dir>] [--provider anthropic|openai] [--model <id>] [--api-key <key>] [--base-url <url>] [--dry-run] [--cleanup-only]');
}

function parseFocusList(value: string | undefined): DreamsFocus[] | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  const parsed = value
    .split(PATH_LIST_SEPARATOR)
    .map((item) => item.trim())
    .filter(isDreamsFocus);

  return parsed.length > 0 ? parsed : undefined;
}

function isDreamsFocus(value: string): value is DreamsFocus {
  return value === 'state_distribution'
    || value === 'thread_coverage'
    || value === 'thread_health'
    || value === 'merge_candidates'
    || value === 'data_quality'
    || value === 'scratch_health'
    || value === 'scratch_thread_alignment';
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeError(`Dreams failed: ${message}`);
  exit(1);
});
