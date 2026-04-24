import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { env } from 'node:process';

import { expandHome, quoteForShell } from './utils.js';

const LAUNCHER_NAME = 'engram';
const MANAGED_MARKER = '# engram-onboarding-managed';
const EXECUTABLE_MODE = 0o755;

type InstallAction = 'created' | 'updated' | 'unchanged' | 'conflict';

export interface CliLauncherInstallResult {
  action: InstallAction;
  launcherPath: string;
  detail?: string;
}

export interface CliLauncherRemoveResult {
  action: 'removed' | 'not_found' | 'conflict';
  launcherPath: string;
  detail?: string;
}

function getHomeDir(): string {
  return env.HOME ?? '';
}

export function getDefaultCliBinDir(): string {
  return path.join(getHomeDir(), '.local', 'bin');
}

export function isDirectoryOnPath(dirPath: string): boolean {
  const pathValue = env.PATH ?? '';
  if (pathValue.trim().length === 0) return false;

  const normalized = path.resolve(expandHome(dirPath));
  return pathValue
    .split(path.delimiter)
    .map((segment) => path.resolve(expandHome(segment)))
    .some((segment) => segment === normalized);
}

function buildLauncherContent(cliEntryPath: string): string {
  return [
    '#!/usr/bin/env bash',
    MANAGED_MARKER,
    'set -euo pipefail',
    `exec node ${quoteForShell(cliEntryPath)} "$@"`,
    '',
  ].join('\n');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const raw = await fs.readFile(filePath, 'utf8');
  return JSON.parse(raw) as unknown;
}

function resolveBinEntryFromPackageJson(value: unknown): string | null {
  if (!isRecord(value) || !('bin' in value)) return null;
  const { bin } = value;
  if (typeof bin === 'string' && bin.length > 0) return bin;
  if (isRecord(bin) && typeof bin.engram === 'string' && bin.engram.length > 0) return bin.engram;
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveCliEntryPath(repoRoot: string): Promise<string> {
  try {
    const packageJsonPath = require.resolve('@interwebalchemy/engram-cli/package.json');
    const packageJson = await readJsonFile(packageJsonPath);
    const binEntry = resolveBinEntryFromPackageJson(packageJson) ?? 'dist/index.js';
    const cliEntryPath = path.resolve(path.dirname(packageJsonPath), binEntry);
    if (await fileExists(cliEntryPath)) return cliEntryPath;
  } catch {
    // Fall through to local-repo fallback.
  }

  const localCliEntryPath = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');
  if (await fileExists(localCliEntryPath)) return localCliEntryPath;

  throw new Error(
    'Unable to locate @interwebalchemy/engram-cli entrypoint. Build/install the CLI package first.',
  );
}

export async function installCliLauncher(options: {
  repoRoot: string;
  binDir: string;
}): Promise<CliLauncherInstallResult> {
  const binDir = path.resolve(expandHome(options.binDir));
  const launcherPath = path.join(binDir, LAUNCHER_NAME);
  const cliEntryPath = await resolveCliEntryPath(options.repoRoot);
  const launcherContent = buildLauncherContent(cliEntryPath);

  await fs.mkdir(binDir, { recursive: true });

  const existing = await fs.readFile(launcherPath, 'utf8').catch(() => null);
  if (existing !== null) {
    if (!existing.includes(MANAGED_MARKER)) {
      return {
        action: 'conflict',
        launcherPath,
        detail: `${launcherPath} already exists and is not managed by onboarding.`,
      };
    }

    if (existing === launcherContent) {
      await fs.chmod(launcherPath, EXECUTABLE_MODE);
      return { action: 'unchanged', launcherPath };
    }

    await fs.writeFile(launcherPath, launcherContent, { mode: EXECUTABLE_MODE });
    await fs.chmod(launcherPath, EXECUTABLE_MODE);
    return { action: 'updated', launcherPath };
  }

  await fs.writeFile(launcherPath, launcherContent, { mode: EXECUTABLE_MODE });
  await fs.chmod(launcherPath, EXECUTABLE_MODE);
  return { action: 'created', launcherPath };
}

export async function removeCliLauncher(binDir: string): Promise<CliLauncherRemoveResult> {
  const normalizedDir = path.resolve(expandHome(binDir));
  const launcherPath = path.join(normalizedDir, LAUNCHER_NAME);
  const content = await fs.readFile(launcherPath, 'utf8').catch(() => null);

  if (content === null) {
    return { action: 'not_found', launcherPath };
  }

  if (!content.includes(MANAGED_MARKER)) {
    return {
      action: 'conflict',
      launcherPath,
      detail: `${launcherPath} exists but is not managed by onboarding.`,
    };
  }

  await fs.unlink(launcherPath);
  return { action: 'removed', launcherPath };
}
