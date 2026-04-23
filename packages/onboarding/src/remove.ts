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
  removeOpencodeGlobalRules,
  type HarnessRemovalResult,
} from './harness-config';
import { removeAgentsSkills } from './harness-skills';
import { removeClaudeCodeMcp } from './remove-claude-code';
import { removeCliConfig } from './config';
import { removeShellExports, type ShellProfileRemovalResult } from './shell-profile';
import { removeCliLauncher, type CliLauncherRemoveResult } from './cli-launcher';
import type { ExistingConfig, HarnessOption } from './types';

export interface RemoveOptions {
  rl: readline.Interface;
  existing: ExistingConfig;
  harnesses: HarnessOption[];
  repoRoot: string;
  envPath: string;
  repoContext: boolean;
}

// ── Output helpers ──────────────────────────────────────────────────────────

function writeLine(message = ''): void {
  process.stdout.write(`${message}\n`);
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

  if (existing.harnesses.claudeDesktop) results.push(await removeClaudeDesktopMcp());
  if (existing.harnesses.cursor) results.push(await removeCursorMcp());
  if (existing.harnesses.vscode) results.push(await removeVsCodeMcp());
  if (existing.harnesses.copilot) results.push(await removeCopilotMcp());
  if (existing.harnesses.windsurf) results.push(await removeWindsurfMcp());
  if (existing.harnesses.opencode) results.push(await removeOpencodeMcp());
  if (existing.harnesses.claudeCode) results.push(await removeClaudeCodeMcp());

  for (const result of results) {
    const prefix = result.action === 'removed' ? '  removed' : `  ${result.action}`;
    writeLine(`${prefix}: ${result.harness} — ${result.detail}`);
  }
}

async function removeBootstrapFiles(existing: ExistingConfig): Promise<void> {
  const result = await removeBootstrap();
  switch (result.action) {
    case 'deleted':
      writeLine(`Deleted ${result.path} (was only Engram content)`);
      break;
    case 'stripped':
      writeLine(`Stripped Engram block from ${result.path} (preserved other content)`);
      break;
    case 'not_found':
      writeLine('No Engram bootstrap found in ~/.claude/CLAUDE.md');
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
      writeLine(`Stripped Engram block from ${windsurfResult.path}`);
      break;
    case 'not_found':
      writeLine('No Engram bootstrap found in Windsurf global rules');
      break;
  }
}

async function removeOpencodeBootstrap(existing: ExistingConfig): Promise<void> {
  if (!existing.harnesses.opencode) return;

  const opencodeResult = await removeOpencodeGlobalRules();
  switch (opencodeResult.action) {
    case 'stripped':
      writeLine(`Stripped Engram block from ${opencodeResult.path}`);
      break;
    case 'not_found':
      writeLine('No Engram bootstrap found in OpenCode global rules');
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
    writeLine('No ~/.agents skill files found for Engram.');
    return;
  }
  for (const action of actions) {
    writeLine(`Agent skills: ${action}`);
  }
}

async function removePlugin(rl: readline.Interface, vaultPath: string): Promise<void> {
  if (!(await askYesNo(rl, 'Remove Obsidian plugin from vault?', true))) return;

  const actions = await removeObsidianPlugin(vaultPath);
  for (const action of actions) {
    writeLine(`  ${action}`);
  }
  if (actions.length === 0) {
    writeLine('  no plugin files found');
  }
}

async function removeVaultData(
  rl: readline.Interface,
  existing: ExistingConfig,
): Promise<void> {
  const engramDir = path.join(existing.vaultPath, existing.engramRoot);
  if (!(await directoryExists(engramDir))) return;

  writeLine(`Your Engram data lives at: ${engramDir}`);
  writeLine('This contains your memories, soul document, threads, and scratch log.');
  writeLine();

  if (!(await askYesNo(rl, 'Delete Engram vault data? (THIS CANNOT BE UNDONE)', false))) {
    writeLine('Vault data preserved.');
    return;
  }

  writeLine();
  const confirmName = await ask(rl, `Type "${existing.agentName}" to confirm deletion`);
  if (confirmName === existing.agentName) {
    await fs.rm(engramDir, { recursive: true });
    writeLine(`Deleted ${engramDir}`);
  } else {
    writeLine('Confirmation did not match. Skipping vault data deletion.');
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

function formatShellRemoval(result: ShellProfileRemovalResult): string {
  switch (result.action) {
    case 'deleted':
      return `Deleted ${result.path} (Engram shell exports were the only content)`;
    case 'stripped':
      return `Stripped Engram shell exports from ${result.path}`;
    case 'not_found':
      return `No Engram shell exports found in ${result.path}`;
    case 'error':
      return `Failed to update ${result.path}: ${result.detail ?? 'unknown error'}`;
  }
}

function formatCliLauncherRemoval(result: CliLauncherRemoveResult): string {
  switch (result.action) {
    case 'removed':
      return `Removed CLI launcher ${result.launcherPath}`;
    case 'not_found':
      return `No managed CLI launcher found at ${result.launcherPath}`;
    case 'conflict':
      return result.detail ?? `CLI launcher conflict at ${result.launcherPath}`;
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

  writeLine();
  const results = await removeShellExports(existing.shellProfilePath);
  const meaningfulResults = results.filter((result) => result.action !== 'not_found');
  if (meaningfulResults.length === 0) {
    writeLine('No Engram shell profile exports found.');
    return;
  }

  for (const result of meaningfulResults) {
    writeLine(formatShellRemoval(result));
  }
}

async function maybeClearRepoEnv(
  rl: readline.Interface,
  envPath: string,
  harnesses: HarnessOption[],
  repoContext: boolean,
): Promise<void> {
  if (!repoContext) return;

  writeLine();
  if (await askYesNo(rl, 'Clear Engram values from repo .env?', true)) {
    await clearEngramEnvValues(envPath, harnesses.map((h) => h.envKey));
    writeLine('Cleared Engram configuration from .env');
  }
}

async function maybeRemoveSavedConfig(
  rl: readline.Interface,
  existing: ExistingConfig,
): Promise<void> {
  writeLine();
  if (!(await askYesNo(rl, `Remove saved config at ${existing.configPath}?`, existing.source !== 'default'))) {
    return;
  }

  const result = await removeCliConfig();
  writeLine(result.removed ? `Deleted ${result.path}` : `No config file found at ${result.path}`);
}

async function maybeRemoveCliLauncherFile(
  rl: readline.Interface,
  existing: ExistingConfig,
): Promise<void> {
  if (existing.cliBinDir === null) return;

  writeLine();
  if (!(await askYesNo(rl, `Remove managed CLI launcher from ${existing.cliBinDir}?`, true))) {
    return;
  }

  const result = await removeCliLauncher(existing.cliBinDir);
  writeLine(formatCliLauncherRemoval(result));
}

// ── Main remove flow ────────────────────────────────────────────────────────

export async function runRemove(options: RemoveOptions): Promise<void> {
  const { rl, existing, harnesses, repoRoot, envPath, repoContext } = options;

  writeLine('Engram Onboarding CLI — remove');
  writeLine();
  writeLine('This will remove Engram integrations from configured harnesses.');
  writeLine(`Configuration source: ${describeConfigSource(existing, repoRoot, envPath)}`);
  writeLine();

  const configuredHarnesses = harnesses.filter((h) => existing.harnesses[h.key]);
  if (configuredHarnesses.length > 0) {
    writeLine('Configured harnesses:');
    for (const h of configuredHarnesses) {
      writeLine(`  - ${h.label}`);
    }
  } else {
    writeLine('No harnesses configured in saved Engram settings.');
  }
  writeLine(`Vault: ${existing.vaultPath}`);
  writeLine(`Engram root: ${existing.engramRoot}`);
  writeLine();

  if (!(await askYesNo(rl, 'Proceed with removal?', false))) {
    writeLine('Cancelled.');
    return;
  }

  writeLine();
  await removeHarnessConfigs(existing);

  writeLine();
  await removeBootstrapFiles(existing);

  await removePlugin(rl, existing.vaultPath);

  writeLine();
  await removeVaultData(rl, existing);

  await maybeRemoveShellProfileExports(rl, existing);
  await maybeRemoveCliLauncherFile(rl, existing);
  await maybeClearRepoEnv(rl, envPath, harnesses, repoContext);
  await maybeRemoveSavedConfig(rl, existing);

  if (existing.harnesses.cursor) {
    writeLine();
    writeLine('Note: Cursor rules must be removed manually.');
    writeLine('  Open Cursor Settings > General > Rules, Skills, Subagents');
    writeLine('  Find and remove the Engram bootstrap rule.');
  }

  writeLine();
  writeLine('Removal complete.');
}
