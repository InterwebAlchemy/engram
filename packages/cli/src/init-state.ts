import * as path from 'node:path';

import { buildEnvUpdates, upsertEnvFile } from './env-file';
import { saveCliConfig } from './config';
import { removeShellExportsFromPaths, upsertShellExports } from './shell-profile';
import type { ExistingConfig, HarnessOption, InitAnswers, PersistedConfig } from './types';

function writeLine(message = ''): void {
  process.stdout.write(`${message}\n`);
}

export function buildPersistedConfig(answers: InitAnswers): PersistedConfig {
  const gitIdentity = answers.gitName.trim().length > 0 && answers.gitEmail.trim().length > 0
    ? `${answers.gitName.trim()} <${answers.gitEmail.trim()}>`
    : '';
  return {
    version: 1,
    agentName: answers.agentName,
    gitIdentity,
    vaultPath: answers.vaultPath,
    engramRoot: answers.engramRoot,
    snapshotDir: answers.snapshotDir,
    harnesses: answers.harnesses,
    claudeCodeScope: answers.claudeCodeScope,
    voicePreset: answers.voicePreset,
    ...(answers.shellProfilePath === null ? {} : { shellProfilePath: answers.shellProfilePath }),
  };
}

export function printInitMode(existing: ExistingConfig, repoContext: boolean): void {
  switch (existing.source) {
    case 'config':
      writeLine(`Detected existing config at ${existing.configPath}.`);
      writeLine('Press Enter to keep a current value, or change the fields you want to update.');
      break;
    case 'env':
      writeLine('Detected an existing repo .env configuration.');
      writeLine(`This run will migrate it into ${existing.configPath} and keep .env as a dev-only mirror.`);
      break;
    case 'default':
      writeLine('No existing Engram CLI config found. This will create one.');
      if (repoContext) {
        writeLine('Because you are inside the Engram repo, the dev .env will also stay in sync.');
      } else {
        writeLine('Outside the repo, Engram will use ~/.engram/config.json and optional shell exports instead of .env.');
      }
      break;
  }
}

export async function persistInitState(options: {
  answers: InitAnswers;
  envPath: string;
  existing: ExistingConfig;
  repoContext: boolean;
  repoRoot: string;
  harnesses: HarnessOption[];
}): Promise<void> {
  const { answers, envPath, existing, repoContext, repoRoot, harnesses } = options;
  const envUpdates = buildEnvUpdates(answers, harnesses);
  await saveCliConfig(buildPersistedConfig(answers));
  writeLine(`Saved config → ${existing.configPath}`);

  if (repoContext) {
    await upsertEnvFile(envPath, envUpdates);
    const envRelative = path.relative(repoRoot, envPath);
    writeLine(`Synced repo dev env → ${envRelative.length > 0 ? envRelative : '.env'}`);
    return;
  }

  let { shellProfilePath } = answers;
  const { shellProfilePath: oldShellProfilePath } = existing;
  if (oldShellProfilePath !== null && oldShellProfilePath !== shellProfilePath) {
    const results = await removeShellExportsFromPaths([oldShellProfilePath]);
    for (const result of results.filter((entry) => entry.path === oldShellProfilePath)) {
      writeLine(formatShellRemoval(result));
    }
  }

  if (shellProfilePath !== null) {
    const result = await upsertShellExports(shellProfilePath, envUpdates);
    const { path: persistedShellProfilePath, action } = result;
    shellProfilePath = persistedShellProfilePath;
    writeLine(`Shell exports → ${persistedShellProfilePath} (${action})`);
  }

  if (shellProfilePath !== answers.shellProfilePath) {
    await saveCliConfig(buildPersistedConfig({ ...answers, shellProfilePath }));
  }
}

function formatShellRemoval(result: {
  path: string;
  action: 'deleted' | 'stripped' | 'not_found' | 'error';
  detail?: string;
}): string {
  switch (result.action) {
    case 'deleted':
      return `Shell exports → deleted ${result.path}`;
    case 'stripped':
      return `Shell exports → removed Engram block from ${result.path}`;
    case 'not_found':
      return `Shell exports → no Engram block found in ${result.path}`;
    case 'error':
      return `Shell exports → failed to update ${result.path}: ${result.detail ?? 'unknown error'}`;
  }
}
