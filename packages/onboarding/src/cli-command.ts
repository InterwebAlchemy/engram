import type * as readline from 'node:readline/promises';

import { detectShellProfile } from './shell-profile';
import { askRequired, askYesNo } from './prompt-helpers';
import {
  getDefaultCliBinDir,
  installCliLauncher,
  isDirectoryOnPath,
} from './cli-launcher';
import { expandHome } from './utils';
import type { ExistingConfig } from './types';

export interface CliCommandConfig {
  cliBinDir: string | null;
  shellProfilePath: string | null;
}

export async function askCliCommandConfig(options: {
  rl: readline.Interface;
  existing: ExistingConfig;
  repoContext: boolean;
  writeLine: (message?: string) => void;
}): Promise<CliCommandConfig> {
  const {
    rl,
    existing,
    repoContext,
    writeLine,
  } = options;

  writeLine();
  writeLine('CLI command');
  const installCliCommand = await askYesNo(
    rl,
    'Install `engram` command in a user bin directory?',
    true,
  );
  const defaultCliBinDir = existing.cliBinDir ?? getDefaultCliBinDir();
  const cliBinDir = installCliCommand
    ? expandHome(await askRequired(rl, 'CLI bin directory', defaultCliBinDir))
    : null;

  let { shellProfilePath } = existing;
  if (repoContext && cliBinDir !== null && !isDirectoryOnPath(cliBinDir) && shellProfilePath === null) {
    const detection = await detectShellProfile(null);
    const { path: detectedShellProfilePath } = detection;
    writeLine();
    writeLine('Shell profile PATH export');
    writeLine(`Your selected CLI bin directory (${cliBinDir}) is not currently on PATH.`);
    if (await askYesNo(rl, `Add it to PATH in ${detectedShellProfilePath}?`, true)) {
      shellProfilePath = expandHome(await askRequired(rl, 'Shell profile path', detectedShellProfilePath));
    }
  }

  return { cliBinDir, shellProfilePath };
}

export async function ensureCliLauncher(options: {
  repoRoot: string;
  cliBinDir: string | null;
  shellProfilePath: string | null;
  writeLine: (message?: string) => void;
}): Promise<void> {
  const {
    repoRoot,
    cliBinDir,
    shellProfilePath,
    writeLine,
  } = options;

  if (cliBinDir === null) {
    writeLine('CLI launcher → skipped');
    return;
  }

  const result = await installCliLauncher({
    repoRoot,
    binDir: cliBinDir,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeLine(`CLI launcher → failed (${message})`);
    return null;
  });
  if (result === null) return;

  switch (result.action) {
    case 'created':
      writeLine(`CLI launcher → created ${result.launcherPath}`);
      break;
    case 'updated':
      writeLine(`CLI launcher → updated ${result.launcherPath}`);
      break;
    case 'unchanged':
      writeLine(`CLI launcher → unchanged ${result.launcherPath}`);
      break;
    case 'conflict':
      writeLine(`CLI launcher → conflict at ${result.launcherPath}`);
      if (result.detail !== undefined) {
        writeLine(`  ${result.detail}`);
      }
      break;
  }

  if (!isDirectoryOnPath(cliBinDir) && shellProfilePath === null) {
    writeLine(`CLI launcher hint → ${cliBinDir} is not on PATH in this shell.`);
    writeLine('  Add it to PATH or rerun init and enable shell profile exports.');
  }
}
