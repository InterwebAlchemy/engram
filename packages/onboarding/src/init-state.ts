import * as path from 'node:path';

import { buildEnvUpdates, upsertEnvFile } from './env-file.js';
import { saveCliConfig } from './config.js';
import { removeShellExportsFromPaths, upsertShellExports } from './shell-profile.js';
import { note, verboseStatus, warn } from './ui.js';
import type { ExistingConfig, HarnessOption, InitAnswers, PersistedConfig } from './types.js';

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
    ...(answers.cliBinDir === null ? {} : { cliBinDir: answers.cliBinDir }),
    ...(answers.shellProfilePath === null ? {} : { shellProfilePath: answers.shellProfilePath }),
  };
}

export function printInitMode(existing: ExistingConfig, repoContext: boolean): void {
  switch (existing.source) {
    case 'config':
      note(`Detected existing config at ${existing.configPath}.`);
      note('Press Enter to keep a current value, or change the fields you want to update.');
      break;
    case 'env':
      note('Detected an existing repo .env configuration.');
      note(`This run will migrate it into ${existing.configPath} and keep .env as a dev-only mirror.`);
      break;
    case 'default':
      note('No existing Engram CLI config found. This will create one.');
      if (repoContext) {
        note('Because you are inside the Engram repo, the dev .env will also stay in sync.');
      } else {
        note('Outside the repo, Engram will use ~/.engram/config.json and optional shell exports instead of .env.');
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
  verboseStatus('Saved config', existing.configPath);

  if (repoContext) {
    await upsertEnvFile(envPath, envUpdates);
    const envRelative = path.relative(repoRoot, envPath);
    verboseStatus('Repo dev env', envRelative.length > 0 ? envRelative : '.env', 'synced');
  }

  let { shellProfilePath } = answers;
  const { shellProfilePath: oldShellProfilePath } = existing;
  if (oldShellProfilePath !== null && oldShellProfilePath !== shellProfilePath) {
    const results = await removeShellExportsFromPaths([oldShellProfilePath]);
    for (const result of results.filter((entry) => entry.path === oldShellProfilePath)) {
      reportShellRemoval(result);
    }
  }

  if (shellProfilePath !== null) {
    const shellEnvUpdates = !repoContext || oldShellProfilePath !== null
      ? envUpdates
      : {};
    const result = await upsertShellExports(shellProfilePath, shellEnvUpdates, {
      pathPrependDir: answers.cliBinDir,
    });
    const { path: persistedShellProfilePath, action } = result;
    shellProfilePath = persistedShellProfilePath;
    verboseStatus('Shell exports', persistedShellProfilePath, action);
  }

  if (shellProfilePath !== answers.shellProfilePath) {
    await saveCliConfig(buildPersistedConfig({ ...answers, shellProfilePath }));
  }
}

function reportShellRemoval(result: {
  path: string;
  action: 'deleted' | 'stripped' | 'not_found' | 'error';
  detail?: string;
}): void {
  switch (result.action) {
    case 'deleted':
      verboseStatus('Shell exports', result.path, 'deleted');
      break;
    case 'stripped':
      verboseStatus('Shell exports', result.path, 'removed Engram block');
      break;
    case 'not_found':
      note(`Shell exports → no Engram block found in ${result.path}`);
      break;
    case 'error':
      warn(`Shell exports → failed to update ${result.path}: ${result.detail ?? 'unknown error'}`);
      break;
  }
}
