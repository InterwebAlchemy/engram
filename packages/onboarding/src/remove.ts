/**
 * `onboarding remove` — interactively tears down Engram integrations
 * and optionally deletes vault data.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type * as readline from 'node:readline/promises';

import {
  removeBootstrap,
  removeClaudeDesktopMcp,
  removeCopilotMcp,
  removeCursorMcp,
  removeObsidianPlugin,
  removeVsCodeMcp,
  removeWindsurfMcp,
  removeWindsurfGlobalRules,
  removeOpencodeMcp,
  removeZedMcp,
  removeOpencodeGlobalRules,
  type HarnessRemovalResult,
} from './harness-config.js';
import { removeAgentsSkills } from './harness-skills.js';
import { removeClaudeCodeMcp } from './remove-claude-code.js';
import { removeCliConfig } from './config.js';
import { removeShellExports, type ShellProfileRemovalResult } from './shell-profile.js';
import { removeCliLauncher, type CliLauncherRemoveResult } from './cli-launcher.js';
import {
  bullet,
  info,
  note,
  printBanner,
  section,
  status,
  subheading,
  success,
  warn,
  writeLine,
} from './ui.js';
import type { ExistingConfig, HarnessOption } from './types.js';

export interface RemoveOptions {
  rl: readline.Interface;
  existing: ExistingConfig;
  harnesses: HarnessOption[];
  repoRoot: string;
  envPath: string;
  repoContext: boolean;
}

// ── Prompt helpers (duplicated to keep module self-contained) ────────────────

async function ask(rl: readline.Interface, label: string, defaultValue = ''): Promise<string> {
  const suffix = defaultValue.length > 0 ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer.length > 0 ? answer : defaultValue;
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

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

// ── Sub-steps ───────────────────────────────────────────────────────────────

async function removeHarnessConfigs(existing: ExistingConfig): Promise<void> {
  const results: HarnessRemovalResult[] = [];
  const removers: ReadonlyArray<{ enabled: boolean; remove: () => Promise<HarnessRemovalResult> }> = [
    { enabled: existing.harnesses.claudeDesktop, remove: removeClaudeDesktopMcp },
    { enabled: existing.harnesses.cursor, remove: removeCursorMcp },
    { enabled: existing.harnesses.vscode, remove: removeVsCodeMcp },
    { enabled: existing.harnesses.zed, remove: removeZedMcp },
    { enabled: existing.harnesses.copilot, remove: removeCopilotMcp },
    { enabled: existing.harnesses.windsurf, remove: removeWindsurfMcp },
    { enabled: existing.harnesses.opencode, remove: removeOpencodeMcp },
    { enabled: existing.harnesses.claudeCode, remove: removeClaudeCodeMcp },
  ];

  const enabledRemovers = removers.filter((remover) => remover.enabled);
  const removalResults = await Promise.all(enabledRemovers.map(async (remover) => await remover.remove()));
  results.push(...removalResults);

  for (const result of results) {
    if (result.action === 'removed') {
      status(result.harness, result.detail, 'removed');
    } else {
      note(`${result.action}: ${result.harness} — ${result.detail}`);
    }
  }
}

async function removeBootstrapFiles(existing: ExistingConfig): Promise<void> {
  const result = await removeBootstrap();
  switch (result.action) {
    case 'deleted':
      status(result.path, 'deleted (was only Engram content)');
      break;
    case 'stripped':
      status(result.path, 'Engram block stripped (preserved other content)');
      break;
    case 'not_found':
      note('No Engram bootstrap found in ~/.claude/CLAUDE.md');
      break;
  }

  await removeWindsurfBootstrap(existing);
  await removeOpencodeBootstrap(existing);
  await removeSkillBundles(existing);
}

async function removeWindsurfBootstrap(existing: ExistingConfig): Promise<void> {
  if (!existing.harnesses.windsurf) return;

  const windsurfResult = await removeWindsurfGlobalRules();
  switch (windsurfResult.action) {
    case 'stripped':
      status(windsurfResult.path, 'Engram block stripped');
      break;
    case 'not_found':
      note('No Engram bootstrap found in Windsurf global rules');
      break;
  }
}

async function removeOpencodeBootstrap(existing: ExistingConfig): Promise<void> {
  if (!existing.harnesses.opencode) return;

  const opencodeResult = await removeOpencodeGlobalRules();
  switch (opencodeResult.action) {
    case 'stripped':
      status(opencodeResult.path, 'Engram block stripped');
      break;
    case 'not_found':
      note('No Engram bootstrap found in OpenCode global rules');
      break;
  }
}

async function removeSkillBundles(existing: ExistingConfig): Promise<void> {
  await removeAgentsSkillsIfEnabled(existing.harnesses.agentsSkills);
}

async function removeAgentsSkillsIfEnabled(enabled: boolean): Promise<void> {
  if (!enabled) return;

  const actions = await removeAgentsSkills();
  if (actions.length === 0) {
    note('No ~/.agents skill files found for Engram.');
    return;
  }
  for (const action of actions) {
    status('Agent skills', action);
  }
}

async function removePlugin(rl: readline.Interface, vaultPath: string): Promise<void> {
  if (!(await askYesNo(rl, 'Remove Obsidian plugin from vault?', true))) return;

  const actions = await removeObsidianPlugin(vaultPath);
  for (const action of actions) {
    bullet(action);
  }
  if (actions.length === 0) {
    note('no plugin files found');
  }
}

async function removeVaultData(
  rl: readline.Interface,
  existing: ExistingConfig,
): Promise<void> {
  const engramDir = path.join(existing.vaultPath, existing.engramRoot);
  if (!(await directoryExists(engramDir))) return;

  subheading(`Your Engram data lives at: ${engramDir}`);
  note('This contains your memories, soul document, threads, and scratch log.');

  if (!(await askYesNo(rl, 'Delete Engram vault data? (THIS CANNOT BE UNDONE)', false))) {
    info('Vault data preserved.');
    return;
  }

  const confirmName = await ask(rl, `Type "${existing.agentName}" to confirm deletion`);
  if (confirmName === existing.agentName) {
    await fs.rm(engramDir, { recursive: true });
    status(engramDir, 'deleted');
  } else {
    warn('Confirmation did not match. Skipping vault data deletion.');
  }
}

async function clearEngramEnvValues(envPath: string, harnessEnvKeys: string[]): Promise<void> {
  const keysToRemove = new Set([
    'ENGRAM_NAME',
    'ENGRAM_VAULT_PATH',
    'ENGRAM_ROOT',
    'ENGRAM_VOICE_PRESET',
    'ENGRAM_GIT_IDENTITY',
    'ENGRAM_CONFIGURE_PI_SKILLS',
    'GIT_IDENTITY',
    'MCP_CLAUDE_CODE_SCOPE',
    ...harnessEnvKeys,
  ]);

  const SEPARATOR = '=';
  const NEWLINE_PATTERN = /\r?\n/gu;

  try {
    const raw = await fs.readFile(envPath, 'utf8');
    const lines = raw.split(NEWLINE_PATTERN);
    const filtered = lines.filter((line: string) => {
      const idx = line.indexOf(SEPARATOR);
      if (idx === -1) return true;
      const key = line.slice(0, idx).trim();
      return !keysToRemove.has(key);
    });
    const result = `${filtered.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
    await fs.writeFile(envPath, result, 'utf8');
  } catch {
    // .env doesn't exist or can't be read — nothing to clean
  }
}

function reportShellRemoval(result: ShellProfileRemovalResult): void {
  switch (result.action) {
    case 'deleted':
      status(result.path, 'deleted (Engram shell exports were the only content)');
      break;
    case 'stripped':
      status(result.path, 'Engram shell exports stripped');
      break;
    case 'not_found':
      note(`No Engram shell exports found in ${result.path}`);
      break;
    case 'error':
      warn(`Failed to update ${result.path}: ${result.detail ?? 'unknown error'}`);
      break;
  }
}

function reportCliLauncherRemoval(result: CliLauncherRemoveResult): void {
  switch (result.action) {
    case 'removed':
      status('CLI launcher', result.launcherPath, 'removed');
      break;
    case 'not_found':
      note(`No managed CLI launcher found at ${result.launcherPath}`);
      break;
    case 'conflict':
      warn(result.detail ?? `CLI launcher conflict at ${result.launcherPath}`);
      break;
  }
}

function describeConfigSource(existing: ExistingConfig, repoRoot: string, envPath: string): string {
  switch (existing.source) {
    case 'config':
      return existing.configPath;
    case 'env': {
      const envRelative = path.relative(repoRoot, envPath);
      return envRelative.length > 0 ? envRelative : '.env';
    }
    case 'default':
      return 'defaults only (no persisted Engram config found)';
  }
}

async function maybeRemoveShellProfileExports(
  rl: readline.Interface,
  existing: ExistingConfig,
): Promise<void> {
  if (!(await askYesNo(rl, 'Remove Engram shell profile exports?', existing.shellProfilePath !== null))) {
    return;
  }

  const results = await removeShellExports(existing.shellProfilePath);
  const meaningfulResults = results.filter((result) => result.action !== 'not_found');
  if (meaningfulResults.length === 0) {
    note('No Engram shell profile exports found.');
    return;
  }

  for (const result of meaningfulResults) {
    reportShellRemoval(result);
  }
}

async function maybeClearRepoEnv(
  rl: readline.Interface,
  envPath: string,
  harnesses: HarnessOption[],
  repoContext: boolean,
): Promise<void> {
  if (!repoContext) return;

  if (await askYesNo(rl, 'Clear Engram values from repo .env?', true)) {
    await clearEngramEnvValues(envPath, harnesses.map((h) => h.envKey));
    success('Cleared Engram configuration from .env');
  }
}

async function maybeRemoveSavedConfig(
  rl: readline.Interface,
  existing: ExistingConfig,
): Promise<void> {
  if (!(await askYesNo(rl, `Remove saved config at ${existing.configPath}?`, existing.source !== 'default'))) {
    return;
  }

  const result = await removeCliConfig();
  if (result.removed) {
    status(result.path, 'deleted');
  } else {
    note(`No config file found at ${result.path}`);
  }
}

async function maybeRemoveCliLauncherFile(
  rl: readline.Interface,
  existing: ExistingConfig,
): Promise<void> {
  if (existing.cliBinDir === null) return;

  if (!(await askYesNo(rl, `Remove managed CLI launcher from ${existing.cliBinDir}?`, true))) {
    return;
  }

  const result = await removeCliLauncher(existing.cliBinDir);
  reportCliLauncherRemoval(result);
}

// ── Main remove flow ────────────────────────────────────────────────────────

export async function runRemove(options: RemoveOptions): Promise<void> {
  const { rl, existing, harnesses, repoRoot, envPath, repoContext } = options;

  printBanner('Uninstall');
  section('Removal plan');
  note('This will remove Engram integrations from configured harnesses.');
  note(`Configuration source: ${describeConfigSource(existing, repoRoot, envPath)}`);

  const configuredHarnesses = harnesses.filter((h) => existing.harnesses[h.key]);
  if (configuredHarnesses.length > 0) {
    subheading('Configured harnesses:');
    for (const h of configuredHarnesses) {
      bullet(h.label);
    }
  } else {
    note('No harnesses configured in saved Engram settings.');
  }
  note(`Vault: ${existing.vaultPath}`);
  note(`Engram root: ${existing.engramRoot}`);
  writeLine();

  if (!(await askYesNo(rl, 'Proceed with removal?', false))) {
    info('Cancelled.');
    return;
  }

  section('Harness configs');
  await removeHarnessConfigs(existing);

  section('Bootstrap files');
  await removeBootstrapFiles(existing);

  section('Obsidian plugin');
  await removePlugin(rl, existing.vaultPath);

  section('Vault data');
  await removeVaultData(rl, existing);

  section('Shell profile + CLI launcher');
  await maybeRemoveShellProfileExports(rl, existing);
  await maybeRemoveCliLauncherFile(rl, existing);
  await maybeClearRepoEnv(rl, envPath, harnesses, repoContext);
  await maybeRemoveSavedConfig(rl, existing);

  if (existing.harnesses.cursor) {
    subheading('Note: Cursor rules must be removed manually.');
    note('Open Cursor Settings > Cursor Settings > Rules, Skills, Subagents');
    note('Find and remove the Engram bootstrap rule.');
  }

  if (existing.harnesses.zed) {
    subheading('Note: Zed settings must be removed manually.');
    note('Open your Zed settings JSON and remove the "engram" entry from "context_servers".');
  }

  writeLine();
  success('Removal complete.');
}
