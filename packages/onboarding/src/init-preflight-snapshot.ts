import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execPath } from 'node:process';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { askYesNo, type PromptSession } from './prompt-helpers.js';
import { note, status, subheading, withSpinner } from './ui.js';
import type { ExistingConfig, InitAnswers } from './types.js';

const require = createRequire(import.meta.url);

export async function maybeCreatePreflightSnapshot(
  repoRoot: string,
  _existing: ExistingConfig,
  answers: InitAnswers,
  prompt: PromptSession,
): Promise<void> {
  if (!(await shouldOfferPreflightSnapshot(answers))) return;

  subheading(`Existing Engram state detected at ${path.join(answers.vaultPath, answers.engramRoot)}.`);
  note('A snapshot will preserve the current Soul document and the rest of the Engram state before any changes are made.');
  const shouldSnapshot = await askYesNo(prompt, `Create a pre-init snapshot in ${answers.snapshotDir}?`, true);
  if (!shouldSnapshot) return;

  const snapshotId = await withSpinner(
    `Creating pre-init snapshot in ${answers.snapshotDir}…`,
    async () => await createSnapshot(repoRoot, answers),
  );
  status('Snapshot', snapshotId, 'created');
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
