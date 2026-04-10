#!/usr/bin/env node

import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { SnapshotManager } from './manager';
import type { SnapshotRecord } from './types';

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);

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
    case undefined:
      printHelp();
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

async function runCreate(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const vaultPath = await resolveVaultPath(args.vault);
  const manager = new SnapshotManager({
    snapshotsDir: args.snapshotsDir ? path.resolve(args.snapshotsDir) : undefined,
  });

  const snapshot = await manager.create({
    vaultPath,
    engramRoot: args.engramRoot,
    label: args.label,
    reason: args.reason,
  });

  console.log(`Created snapshot ${snapshot.id}`);
  console.log(`Vault: ${vaultPath}`);
  console.log(`Snapshots dir: ${manager.getSnapshotsDir()}`);
  console.log(`Size: ${formatBytes(snapshot.sizeBytes)}`);
}

async function runList(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const manager = new SnapshotManager({
    snapshotsDir: args.snapshotsDir ? path.resolve(args.snapshotsDir) : undefined,
  });
  const snapshots = await manager.list();

  if (args.json) {
    console.log(JSON.stringify(snapshots, null, 2));
    return;
  }

  if (snapshots.length === 0) {
    console.log(`No snapshots found in ${manager.getSnapshotsDir()}`);
    return;
  }

  console.log(`Snapshots in ${manager.getSnapshotsDir()}:`);
  console.log('');
  snapshots.forEach((snapshot, index) => {
    const suffix = [
      snapshot.source === 'legacy' ? 'legacy' : undefined,
      snapshot.label,
      snapshot.reason,
    ].filter(Boolean).join(' · ');
    const descriptor = suffix.length > 0 ? `  ${suffix}` : '';
    console.log(
      `${String(index + 1).padStart(2, ' ')}. ${snapshot.id}  ${formatBytes(snapshot.sizeBytes)}${descriptor}`,
    );
  });
}

async function runRestore(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const vaultPath = await resolveVaultPath(args.vault);
  const manager = new SnapshotManager({
    snapshotsDir: args.snapshotsDir ? path.resolve(args.snapshotsDir) : undefined,
  });

  const target = args.positionals[0] ?? await promptForSnapshot(manager);
  if (!target) {
    console.log('Restore cancelled.');
    return;
  }

  if (!args.yes) {
    const confirmed = await confirmRestore(target, manager.getSnapshotsDir(), vaultPath, args.engramRoot);
    if (!confirmed) {
      console.log('Restore cancelled.');
      return;
    }
  }

  const result = await manager.restore({
    snapshotIdOrPath: target,
    vaultPath,
    engramRoot: args.engramRoot,
    createSafetySnapshot: !args.noSafety,
    preserveRelativePaths: args.preserveRelativePaths,
    label: args.label,
    reason: args.reason,
  });

  console.log(`Restored snapshot ${result.restored.id}`);
  if (result.safetySnapshot) {
    console.log(`Safety snapshot: ${result.safetySnapshot.id}`);
  }
  if (result.preservedRelativePaths && result.preservedRelativePaths.length > 0) {
    console.log(`Preserved: ${result.preservedRelativePaths.join(', ')}`);
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

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--vault':
        parsed.vault = argv[++i];
        break;
      case '--engram-root':
        parsed.engramRoot = argv[++i];
        break;
      case '--snapshots-dir':
        parsed.snapshotsDir = argv[++i];
        break;
      case '--label':
        parsed.label = argv[++i];
        break;
      case '--reason':
        parsed.reason = argv[++i];
        break;
      case '--preserve-relative':
        parsed.preserveRelativePaths.push(...(argv[++i] ?? '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean));
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
        parsed.positionals.push(arg);
        break;
    }
  }

  return parsed;
}

async function promptForSnapshot(manager: SnapshotManager): Promise<string | null> {
  const snapshots = await manager.list();
  if (snapshots.length === 0) return null;

  console.log(`Snapshots in ${manager.getSnapshotsDir()}:`);
  snapshots.forEach((snapshot, index) => {
    console.log(`${index + 1}. ${snapshot.id} (${formatBytes(snapshot.sizeBytes)})`);
  });

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`Restore which snapshot? (1-${snapshots.length}): `)).trim();
    const selectedIndex = Number.parseInt(answer, 10);
    if (!Number.isFinite(selectedIndex) || selectedIndex < 1 || selectedIndex > snapshots.length) {
      throw new Error('Invalid snapshot selection.');
    }
    return snapshots[selectedIndex - 1]?.id ?? null;
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
    console.log('');
    console.log(`Restoring: ${snapshotId}`);
    console.log(`Snapshots dir: ${snapshotsDir}`);
    console.log(`Target: ${path.join(vaultPath, engramRoot ?? 'engram')}`);
    const answer = (await rl.question('This will replace the current Engram state. Continue? [y/N]: ')).trim();
    return answer === 'y' || answer === 'Y';
  } finally {
    rl.close();
  }
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

function formatBytes(value?: number): string {
  if (!value || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function printHelp(): void {
  console.log('Usage:');
  console.log('  engram-snapshot create [--vault <path>] [--snapshots-dir <path>] [--label <text>] [--reason <text>]');
  console.log('  engram-snapshot list [--snapshots-dir <path>] [--json]');
  console.log('  engram-snapshot restore [snapshot-id-or-path] [--vault <path>] [--snapshots-dir <path>] [--preserve-relative <path[,path...]>] [--yes] [--no-safety]');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Snapshot command failed: ${message}`);
  process.exit(1);
});
