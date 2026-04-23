import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { env, platform } from 'node:process';

import { expandHome, quoteForShell } from './utils';

const MARKER_START = '# >>> engram >>>';
const MARKER_END = '# <<< engram <<<';
const MARKED_BLOCK_PATTERN = /\n*# >>> engram >>>\n[\s\S]*?# <<< engram <<<\n*/u;

export interface ShellProfileDetection {
  path: string;
  shellName: string;
  exists: boolean;
}

export interface ShellProfileWriteResult {
  path: string;
  action: 'created' | 'injected' | 'updated';
}

export interface ShellExportOptions {
  pathPrependDir?: string | null;
}

export interface ShellProfileRemovalResult {
  path: string;
  action: 'deleted' | 'stripped' | 'not_found' | 'error';
  detail?: string;
}

function homeDir(): string {
  return env.HOME ?? '';
}

function shellBasename(): string {
  const rawShell = env.SHELL ?? '';
  return path.basename(rawShell).trim().toLowerCase();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function candidateProfiles(shellName: string): string[] {
  const home = homeDir();
  const defaults = [
    path.join(home, '.zshrc'),
    path.join(home, '.bash_profile'),
    path.join(home, '.bashrc'),
    path.join(home, '.profile'),
  ];

  switch (shellName) {
    case 'zsh':
      return [
        path.join(home, '.zshrc'),
        path.join(home, '.zprofile'),
        ...defaults,
      ];
    case 'bash':
      return platform === 'darwin'
        ? [path.join(home, '.bash_profile'), path.join(home, '.bashrc'), ...defaults]
        : [path.join(home, '.bashrc'), path.join(home, '.bash_profile'), ...defaults];
    default:
      return [path.join(home, '.profile'), ...defaults];
  }
}

export async function detectShellProfile(
  preferredPath: string | null = null,
): Promise<ShellProfileDetection> {
  if (preferredPath !== null && preferredPath.trim().length > 0) {
    const expanded = expandHome(preferredPath.trim());
    return {
      path: expanded,
      shellName: shellBasename(),
      exists: await fileExists(expanded),
    };
  }

  const shellName = shellBasename();
  const candidates = Array.from(new Set(candidateProfiles(shellName)));
  const candidateStates = await Promise.all(candidates.map(async (candidate) => ({
    candidate,
    exists: await fileExists(candidate),
  })));
  const existingCandidate = candidateStates.find((entry) => entry.exists);
  if (existingCandidate !== undefined) {
    return { path: existingCandidate.candidate, shellName, exists: true };
  }

  const [fallback] = candidates;
  return {
    path: fallback,
    shellName,
    exists: false,
  };
}

function buildMarkedBlock(
  updates: Record<string, string>,
  options: ShellExportOptions = {},
): string {
  const lines = [
    MARKER_START,
    '# Engram CLI exports',
    ...Object.entries(updates).map(([key, value]) => `export ${key}=${quoteForShell(value)}`),
    ...(options.pathPrependDir === null || options.pathPrependDir === undefined
      ? []
      : [
          `export ENGRAM_BIN_DIR=${quoteForShell(options.pathPrependDir)}`,
          'case ":$PATH:" in',
          '  *":$ENGRAM_BIN_DIR:"*) ;;',
          '  *) export PATH="$ENGRAM_BIN_DIR:$PATH" ;;',
          'esac',
        ]),
    MARKER_END,
  ];
  return lines.join('\n');
}

function hasMarkedBlock(content: string): boolean {
  return content.includes(MARKER_START) && content.includes(MARKER_END);
}

function stripMarkedBlock(content: string): string {
  if (!hasMarkedBlock(content)) return content;
  return `${content.replace(MARKED_BLOCK_PATTERN, '\n').replace(/^\n+|\n+$/gu, '').trim()}\n`;
}

function isOnlyMarkedBlock(content: string): boolean {
  return stripMarkedBlock(content).trim().length === 0;
}

export async function upsertShellExports(
  profilePath: string,
  updates: Record<string, string>,
  options: ShellExportOptions = {},
): Promise<ShellProfileWriteResult> {
  const normalizedPath = expandHome(profilePath);
  const existing = (await readTextFile(normalizedPath)) ?? '';
  const block = buildMarkedBlock(updates, options);

  if (existing.trim().length === 0) {
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
    await fs.writeFile(normalizedPath, `${block}\n`, 'utf8');
    return { path: normalizedPath, action: 'created' };
  } else if (hasMarkedBlock(existing)) {
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
    await fs.writeFile(normalizedPath, `${existing.replace(MARKED_BLOCK_PATTERN, `\n\n${block}\n`).trim()}\n`, 'utf8');
    return { path: normalizedPath, action: 'updated' };
  } else {
    await fs.mkdir(path.dirname(normalizedPath), { recursive: true });
    await fs.writeFile(normalizedPath, `${existing.trim()}\n\n${block}\n`, 'utf8');
    return { path: normalizedPath, action: 'injected' };
  }
}

export async function removeShellExports(
  preferredPath: string | null = null,
): Promise<ShellProfileRemovalResult[]> {
  const shellName = shellBasename();
  return await removeShellExportsFromPaths(
    Array.from(
      new Set(
        [
          preferredPath === null ? null : expandHome(preferredPath),
          ...candidateProfiles(shellName),
        ].filter((value): value is string => value !== null && value.length > 0),
      ),
    ),
  );
}

export async function removeShellExportsFromPaths(
  paths: string[],
): Promise<ShellProfileRemovalResult[]> {
  return await Promise.all(paths.map(async (candidate): Promise<ShellProfileRemovalResult> => {
    const content = await readTextFile(candidate);
    if (content === null || !hasMarkedBlock(content)) {
      return { path: candidate, action: 'not_found' };
    }

    try {
      if (isOnlyMarkedBlock(content)) {
        await fs.unlink(candidate);
        return { path: candidate, action: 'deleted' };
      } else {
        await fs.writeFile(candidate, stripMarkedBlock(content), 'utf8');
        return { path: candidate, action: 'stripped' };
      }
    } catch (error: unknown) {
      return {
        path: candidate,
        action: 'error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }));
}
