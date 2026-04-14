#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import {
  argv,
  env,
  exit,
  stderr,
  stdin as input,
  stdout as output,
} from 'node:process';
import { SnapshotManager } from './manager';

const CLI_ARG_START_INDEX = 2;
const REPO_ROOT_SEGMENTS_UP = '../../..';
const DEFAULT_ENGRAM_ROOT = 'engram';
const PATH_LIST_SEPARATOR = ',';
const LIST_DISPLAY_OFFSET = 1;
const LIST_INDEX_WIDTH = 2;
const DECIMAL_RADIX = 10;
const JSON_INDENT = 2;
const BYTES_PER_KILOBYTE = 1024;
const KILOBYTES_PER_MEGABYTE = 1024;
const CARRIAGE_RETURN_PATTERN = /\r?\n/gv;
const WRAPPED_QUOTES_PATTERN = /^['"]|['"]$/gv;
const BACKSLASH_PATTERN = /\\/gv;

function writeLine(message = ''): void {
  output.write(`${message}\n`);
}

function writeError(message: string): void {
  stderr.write(`${message}\n`);
}

async function main(): Promise<void> {
  const command = argv.at(CLI_ARG_START_INDEX);
  const rest = argv.slice(CLI_ARG_START_INDEX + LIST_DISPLAY_OFFSET);
  if (command === undefined) {
    printHelp();
    return;
  }

  switch (command) {
    case 'create':
      await runCreate(rest);
      return;
    case 'list':
      await runList(rest);
      return;
    case 'restore':
      await runRestore(rest);
      return;
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const vaultPath = await resolveVaultPath(args.vault);
  const engramRoot = await resolveEngramRoot(args.engramRoot);
  const manager = new SnapshotManager({
    snapshotsDir: typeof args.snapshotsDir === 'string' ? path.resolve(args.snapshotsDir) : undefined,
  });

  const snapshot = await manager.create({
    vaultPath,
    engramRoot,
    label: args.label,
    reason: args.reason,
  });

  writeLine(`Created snapshot ${snapshot.id}`);
  writeLine(`Vault: ${vaultPath}`);
  writeLine(`Snapshots dir: ${manager.getSnapshotsDir()}`);
  writeLine(`Size: ${formatBytes(snapshot.sizeBytes)}`);
}

async function runList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const manager = new SnapshotManager({
    snapshotsDir: typeof args.snapshotsDir === 'string' ? path.resolve(args.snapshotsDir) : undefined,
  });
  const snapshots = await manager.list();

  if (args.json) {
    writeLine(JSON.stringify(snapshots, null, JSON_INDENT));
    return;
  }

  if (snapshots.length === 0) {
    writeLine(`No snapshots found in ${manager.getSnapshotsDir()}`);
    return;
  }

  writeLine(`Snapshots in ${manager.getSnapshotsDir()}:`);
  writeLine();
  snapshots.forEach((snapshot, index) => {
    const suffix = [
      snapshot.source === 'legacy' ? 'legacy' : undefined,
      snapshot.label,
      snapshot.reason,
    ].filter((value): value is string => typeof value === 'string' && value.length > 0).join(' · ');
    const descriptor = suffix.length > 0 ? `  ${suffix}` : '';
    writeLine(
      `${String(index + LIST_DISPLAY_OFFSET).padStart(LIST_INDEX_WIDTH, ' ')}. ${snapshot.id}  ${formatBytes(snapshot.sizeBytes)}${descriptor}`,
    );
  });
}

async function runRestore(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const vaultPath = await resolveVaultPath(args.vault);
  const engramRoot = await resolveEngramRoot(args.engramRoot);
  const manager = new SnapshotManager({
    snapshotsDir: typeof args.snapshotsDir === 'string' ? path.resolve(args.snapshotsDir) : undefined,
  });

  const target = args.positionals.at(0) ?? await promptForSnapshot(manager);
  if (target === null || target.length === 0) {
    writeLine('Restore cancelled.');
    return;
  }

  if (!args.yes) {
    const confirmed = await confirmRestore(target, manager.getSnapshotsDir(), vaultPath, engramRoot);
    if (!confirmed) {
      writeLine('Restore cancelled.');
      return;
    }
  }

  const result = await manager.restore({
    snapshotIdOrPath: target,
    vaultPath,
    engramRoot,
    createSafetySnapshot: !args.noSafety,
    preserveRelativePaths: args.preserveRelativePaths,
    label: args.label,
    reason: args.reason,
  });

  writeLine(`Restored snapshot ${result.restored.id}`);
  if (result.safetySnapshot !== undefined) {
    writeLine(`Safety snapshot: ${result.safetySnapshot.id}`);
  }
  if (result.preservedRelativePaths !== undefined && result.preservedRelativePaths.length > 0) {
    writeLine(`Preserved: ${result.preservedRelativePaths.join(', ')}`);
  }
}

interface ParsedArgs {
  vault?: string;
  engramRoot?: string;
  snapshotsDir?: string;
  label?: string;
  reason?: string;
  preserveRelativePaths: string[];
  json: boolean;
  yes: boolean;
  noSafety: boolean;
  positionals: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    preserveRelativePaths: [],
    json: false,
    yes: false,
    noSafety: false,
    positionals: [],
  };

  let index = 0;
  while (index < argv.length) {
    const arg = argv.at(index);
    switch (arg) {
      case '--vault':
        index += 1;
        parsed.vault = argv.at(index);
        break;
      case '--engram-root':
        index += 1;
        parsed.engramRoot = argv.at(index);
        break;
      case '--snapshots-dir':
        index += 1;
        parsed.snapshotsDir = argv.at(index);
        break;
      case '--label':
        index += 1;
        parsed.label = argv.at(index);
        break;
      case '--reason':
        index += 1;
        parsed.reason = argv.at(index);
        break;
      case '--preserve-relative':
        index += 1;
        parsed.preserveRelativePaths.push(...(argv.at(index) ?? '')
          .split(PATH_LIST_SEPARATOR)
          .map((value) => value.trim())
          .filter((value) => value.length > 0));
        break;
      case '--json':
        parsed.json = true;
        break;
      case '--yes':
      case '-y':
        parsed.yes = true;
        break;
      case '--no-safety':
        parsed.noSafety = true;
        break;
      default:
        if (typeof arg === 'string') {
          parsed.positionals.push(arg);
        }
        break;
    }
    index += 1;
  }

  return parsed;
}

async function promptForSnapshot(manager: SnapshotManager): Promise<string | null> {
  const snapshots = await manager.list();
  if (snapshots.length === 0) return null;

  writeLine(`Snapshots in ${manager.getSnapshotsDir()}:`);
  snapshots.forEach((snapshot, index) => {
    writeLine(`${index + LIST_DISPLAY_OFFSET}. ${snapshot.id} (${formatBytes(snapshot.sizeBytes)})`);
  });

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`Restore which snapshot? (1-${snapshots.length}): `)).trim();
    const selectedIndex = Number.parseInt(answer, DECIMAL_RADIX);
    if (!Number.isFinite(selectedIndex) || selectedIndex < 1 || selectedIndex > snapshots.length) {
      throw new Error('Invalid snapshot selection.');
    }
    const snapshot = snapshots.at(selectedIndex - LIST_DISPLAY_OFFSET);
    return snapshot === undefined ? null : snapshot.id;
  } finally {
    rl.close();
  }
}

async function confirmRestore(
  snapshotId: string,
  snapshotsDir: string,
  vaultPath: string,
  engramRoot?: string,
): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    writeLine();
    writeLine(`Restoring: ${snapshotId}`);
    writeLine(`Snapshots dir: ${snapshotsDir}`);
    writeLine(`Target: ${path.join(vaultPath, engramRoot ?? DEFAULT_ENGRAM_ROOT)}`);
    const answer = (await rl.question('This will replace the current Engram state. Continue? [y/N]: ')).trim();
    return answer === 'y' || answer === 'Y';
  } finally {
    rl.close();
  }
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
  const normalized = value.replace(BACKSLASH_PATTERN, '/').replace(/^\/+|\/+$/gv, '');
  return normalized.length > 0 ? normalized : DEFAULT_ENGRAM_ROOT;
}

function formatBytes(value?: number): string {
  if (value === undefined || Number.isNaN(value) || value <= 0) return '0 B';
  if (value < BYTES_PER_KILOBYTE) return `${value} B`;
  if (value < BYTES_PER_KILOBYTE * KILOBYTES_PER_MEGABYTE) {
    return `${(value / BYTES_PER_KILOBYTE).toFixed(1)} KB`;
  }
  return `${(value / (BYTES_PER_KILOBYTE * KILOBYTES_PER_MEGABYTE)).toFixed(1)} MB`;
}

function printHelp(): void {
  writeLine('Usage:');
  writeLine('  engram-snapshot create [--vault <path>] [--engram-root <dir>] [--snapshots-dir <path>] [--label <text>] [--reason <text>]');
  writeLine('  engram-snapshot list [--snapshots-dir <path>] [--json]');
  writeLine('  engram-snapshot restore [snapshot-id-or-path] [--vault <path>] [--engram-root <dir>] [--snapshots-dir <path>] [--preserve-relative <path[,path...]>] [--yes] [--no-safety]');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeError(`Snapshot command failed: ${message}`);
  exit(1);
});
