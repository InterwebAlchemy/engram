import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as readline from 'node:readline/promises';
import { execPath } from 'node:process';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

import type { ExistingConfig, InitAnswers } from './types';

function writeLine(message = ''): void {
  process.stdout.write(`${message}\n`);
}

async function askYesNo(
  rl: readline.Interface,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
  const answer = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
  if (answer.length === 0) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

export async function maybeCreatePreflightSnapshot(
  repoRoot: string,
  _existing: ExistingConfig,
  answers: InitAnswers,
  rl: readline.Interface,
): Promise<void> {
  if (!(await shouldOfferPreflightSnapshot(answers))) return;

  writeLine();
  writeLine(`Existing Engram state detected at ${path.join(answers.vaultPath, answers.engramRoot)}.`);
  writeLine('A snapshot will preserve the current Soul document and the rest of the Engram state before any changes are made.');
  const shouldSnapshot = await askYesNo(rl, `Create a pre-init snapshot in ${answers.snapshotDir}?`, true);
  if (!shouldSnapshot) return;

  const snapshotId = await createSnapshot(repoRoot, answers);
  writeLine(`Snapshot → ${snapshotId}`);
}

async function shouldOfferPreflightSnapshot(
  answers: InitAnswers,
): Promise<boolean> {
  const engramPath = path.join(answers.vaultPath, answers.engramRoot);
  try {
    const stat = await fs.stat(engramPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function createSnapshot(repoRoot: string, answers: InitAnswers): Promise<string> {
  const snapshotCliPath = require.resolve('@interwebalchemy/engram-snapshot');
  const label = `Init preflight snapshot for ${answers.agentName}`;
  const reason = 'cli-init-preflight';
  const child = spawn(execPath, [
    snapshotCliPath,
    'create',
    '--vault',
    answers.vaultPath,
    '--engram-root',
    answers.engramRoot,
    '--snapshots-dir',
    answers.snapshotDir,
    '--label',
    label,
    '--reason',
    reason,
  ], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuffer = '';
  let stderrBuffer = '';
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdoutBuffer += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrBuffer += chunk.toString();
  });

  const exitPromise = once(child, 'exit');
  const errorPromise = once(child, 'error').then(([err]: unknown[]) => {
    throw err instanceof Error ? err : new Error(String(err));
  });
  const result: unknown = await Promise.race([exitPromise, errorPromise]);
  if (!Array.isArray(result)) throw new Error('snapshot command exited without an exit result');
  const code: unknown = result.at(0);
  if (code !== 0) {
    const message = stderrBuffer.trim().length > 0 ? stderrBuffer.trim() : stdoutBuffer.trim();
    throw new Error(`snapshot command failed${message.length > 0 ? `: ${message}` : ''}`);
  }

  const lines = stdoutBuffer.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
  const createdLine = lines.find((line) => line.startsWith('Created snapshot '));
  return createdLine === undefined ? 'created' : createdLine.slice('Created snapshot '.length).trim();
}
