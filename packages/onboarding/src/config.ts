import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { env } from 'node:process';

import { isVoicePreset } from './voice-presets.js';
import { expandHome, normalizeEngramRoot, parseGitIdentity, stripQuotes } from './utils.js';
import type { ExistingConfig, HarnessKey, PersistedConfig } from './types.js';

const CONFIG_DIR_NAME = '.engram';
const CONFIG_FILE_NAME = 'config.json';
const DEFAULT_ENGRAM_ROOT = 'engram';
const DEFAULT_AGENT_NAME = 'gl1tch';
const DEFAULT_CLAUDE_CODE_SCOPE = 'local';
const DEFAULT_SNAPSHOTS_DIR_NAME = 'snapshots';
const TRUE_VALUE = 'true';
const ENV_SEPARATOR = '=';
const NEWLINE_PATTERN = /\r?\n/gu;
const JSON_INDENT = 2;

function homeDir(): string {
  return env.HOME ?? '';
}

function configDirPath(): string {
  return path.join(homeDir(), CONFIG_DIR_NAME);
}

export function getCliConfigPath(): string {
  return path.join(configDirPath(), CONFIG_FILE_NAME);
}

export function getDefaultSnapshotDir(): string {
  return path.join(configDirPath(), DEFAULT_SNAPSHOTS_DIR_NAME);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function defaultHarnesses(): Record<HarnessKey, boolean> {
  return {
    claudeCode: false,
    claudeDesktop: false,
    cursor: false,
    vscode: false,
    zed: false,
    copilot: false,
    windsurf: false,
    opencode: false,
    agentsSkills: false,
  };
}

function coerceBooleanRecord(value: unknown): Record<HarnessKey, boolean> {
  const defaults = defaultHarnesses();
  if (!isRecord(value)) return defaults;

  return {
    claudeCode: value.claudeCode === true,
    claudeDesktop: value.claudeDesktop === true,
    cursor: value.cursor === true,
    vscode: value.vscode === true,
    zed: value.zed === true,
    copilot: value.copilot === true,
    windsurf: value.windsurf === true,
    opencode: value.opencode === true,
    agentsSkills: value.agentsSkills === true,
  };
}

function normalizeAgentName(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : DEFAULT_AGENT_NAME;
}

function normalizeShellProfilePath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? expandHome(value.trim())
    : undefined;
}

function normalizeCliBinDir(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? expandHome(value.trim())
    : undefined;
}

function normalizeSnapshotDir(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? expandHome(value.trim())
    : getDefaultSnapshotDir();
}

function normalizeVoicePreset(value: unknown): PersistedConfig['voicePreset'] {
  return typeof value === 'string' && isVoicePreset(value) ? value : 'collaborator';
}

function normalizePersistedConfig(value: unknown): PersistedConfig | null {
  if (!isRecord(value)) return null;

  const vaultPath = typeof value.vaultPath === 'string' ? expandHome(value.vaultPath) : '';
  if (vaultPath.length === 0) return null;

  const engramRoot = typeof value.engramRoot === 'string'
    ? normalizeEngramRoot(value.engramRoot)
    : DEFAULT_ENGRAM_ROOT;
  const snapshotDir = normalizeSnapshotDir(value.snapshotDir);
  const agentName = normalizeAgentName(value.agentName);
  const gitIdentity = typeof value.gitIdentity === 'string' ? value.gitIdentity.trim() : '';
  const shellProfilePath = normalizeShellProfilePath(value.shellProfilePath);
  const cliBinDir = normalizeCliBinDir(value.cliBinDir);
  const claudeCodeScope = value.claudeCodeScope === 'user' ? 'user' : DEFAULT_CLAUDE_CODE_SCOPE;
  const voicePreset = normalizeVoicePreset(value.voicePreset);

  return {
    version: 1,
    vaultPath,
    engramRoot,
    snapshotDir,
    agentName,
    gitIdentity,
    harnesses: coerceBooleanRecord(value.harnesses),
    claudeCodeScope,
    voicePreset,
    shellProfilePath,
    cliBinDir,
  };
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function readPersistedConfig(): Promise<PersistedConfig | null> {
  const raw = await readTextFile(getCliConfigPath());
  if (raw === null) return null;

  try {
    const parsed: unknown = JSON.parse(raw);
    return normalizePersistedConfig(parsed);
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isRepoContext(repoRoot: string): Promise<boolean> {
  return await fileExists(path.join(repoRoot, 'scripts', 'setup-dev.sh'))
    && await fileExists(path.join(repoRoot, 'templates', 'engram-bootstrap.tmpl.md'));
}

async function readEnvFile(envPath: string): Promise<Partial<Record<string, string>>> {
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    const entries: Partial<Record<string, string>> = {};
    for (const line of raw.split(NEWLINE_PATTERN)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf(ENV_SEPARATOR);
      if (idx === -1) continue;
      entries[trimmed.slice(0, idx).trim()] = stripQuotes(trimmed.slice(idx + 1).trim());
    }
    return entries;
  } catch {
    return {};
  }
}

function hasEnvConfig(envValues: Partial<Record<string, string>>): boolean {
  const relevantKeys = [
    'ENGRAM_NAME',
    'ENGRAM_VAULT_PATH',
    'ENGRAM_ROOT',
    'ENGRAM_VOICE_PRESET',
    'ENGRAM_GIT_IDENTITY',
    'GIT_IDENTITY',
    'MCP_CLAUDE_CODE_SCOPE',
    'MCP_CONFIGURE_CLAUDE_CODE',
    'MCP_CONFIGURE_CLAUDE_DESKTOP',
    'MCP_CONFIGURE_CURSOR',
    'MCP_CONFIGURE_VSCODE',
    'MCP_CONFIGURE_ZED',
    'MCP_CONFIGURE_COPILOT',
    'MCP_CONFIGURE_WINDSURF',
    'MCP_CONFIGURE_OPENCODE',
    'ENGRAM_CONFIGURE_AGENTS_SKILLS',
  ];
  return relevantKeys.some((key) => typeof envValues[key] === 'string' && envValues[key] !== '');
}

function buildExistingConfig(
  source: ExistingConfig['source'],
  configPath: string,
  value: PersistedConfig,
): ExistingConfig {
  const { name: gitName, email: gitEmail } = parseGitIdentity(value.gitIdentity);

  return {
    source,
    configPath,
    vaultPath: value.vaultPath,
    engramRoot: value.engramRoot,
    snapshotDir: value.snapshotDir,
    agentName: value.agentName,
    gitIdentity: value.gitIdentity,
    gitName,
    gitEmail,
    harnesses: value.harnesses,
    claudeCodeScope: value.claudeCodeScope,
    voicePreset: value.voicePreset,
    shellProfilePath: value.shellProfilePath ?? null,
    cliBinDir: value.cliBinDir ?? null,
  };
}

function buildEnvFallbackConfig(
  envValues: Partial<Record<string, string>>,
  repoRoot: string,
): PersistedConfig {
  const gitIdentity = envValues.GIT_IDENTITY ?? envValues.ENGRAM_GIT_IDENTITY ?? '';
  return {
    version: 1,
    vaultPath: expandHome(envValues.ENGRAM_VAULT_PATH ?? path.join(repoRoot, 'tmp', 'Engram Test Vault')),
    engramRoot: normalizeEngramRoot(envValues.ENGRAM_ROOT ?? DEFAULT_ENGRAM_ROOT),
    snapshotDir: getDefaultSnapshotDir(),
    agentName: envValues.ENGRAM_NAME ?? DEFAULT_AGENT_NAME,
    gitIdentity,
    harnesses: {
      claudeCode: envValues.MCP_CONFIGURE_CLAUDE_CODE === TRUE_VALUE,
      claudeDesktop: envValues.MCP_CONFIGURE_CLAUDE_DESKTOP === TRUE_VALUE,
      cursor: envValues.MCP_CONFIGURE_CURSOR === TRUE_VALUE,
      vscode: envValues.MCP_CONFIGURE_VSCODE === TRUE_VALUE,
      zed: envValues.MCP_CONFIGURE_ZED === TRUE_VALUE,
      copilot: envValues.MCP_CONFIGURE_COPILOT === TRUE_VALUE,
      windsurf: envValues.MCP_CONFIGURE_WINDSURF === TRUE_VALUE,
      opencode: envValues.MCP_CONFIGURE_OPENCODE === TRUE_VALUE,
      agentsSkills: envValues.ENGRAM_CONFIGURE_AGENTS_SKILLS === TRUE_VALUE,
    },
    claudeCodeScope: envValues.MCP_CLAUDE_CODE_SCOPE === 'user' ? 'user' : DEFAULT_CLAUDE_CODE_SCOPE,
    voicePreset: isVoicePreset(envValues.ENGRAM_VOICE_PRESET) ? envValues.ENGRAM_VOICE_PRESET : 'collaborator',
  };
}

export async function loadExistingConfig(
  envPath: string,
  repoRoot: string,
): Promise<ExistingConfig> {
  const configPath = getCliConfigPath();
  const persisted = await readPersistedConfig();
  if (persisted !== null) {
    return buildExistingConfig('config', configPath, persisted);
  }

  if (await isRepoContext(repoRoot)) {
    const envValues = await readEnvFile(envPath);
    if (hasEnvConfig(envValues)) {
      return buildExistingConfig('env', configPath, buildEnvFallbackConfig(envValues, repoRoot));
    }
  }

  return buildExistingConfig('default', configPath, {
    version: 1,
    vaultPath: path.join(repoRoot, 'tmp', 'Engram Test Vault'),
    engramRoot: DEFAULT_ENGRAM_ROOT,
    snapshotDir: getDefaultSnapshotDir(),
    agentName: DEFAULT_AGENT_NAME,
    gitIdentity: '',
    harnesses: defaultHarnesses(),
    claudeCodeScope: DEFAULT_CLAUDE_CODE_SCOPE,
    voicePreset: 'collaborator',
  });
}

export async function saveCliConfig(config: PersistedConfig): Promise<string> {
  const configPath = getCliConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, JSON_INDENT)}\n`, 'utf8');
  return configPath;
}

export async function removeCliConfig(): Promise<{ path: string; removed: boolean }> {
  const configPath = getCliConfigPath();
  try {
    await fs.unlink(configPath);
  } catch {
    return { path: configPath, removed: false };
  }

  try {
    await fs.rmdir(configDirPath());
  } catch {
    // Directory still has content or does not exist. That's fine.
  }

  return { path: configPath, removed: true };
}
