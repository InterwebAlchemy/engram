import { detectShellProfile } from './shell-profile.js';
import {
  askPathRequired,
  askYesNo,
  type PromptSession,
} from './prompt-helpers.js';
import {
  getDefaultCliBinDir,
  installCliLauncher,
  isDirectoryOnPath,
} from './cli-launcher.js';
import { expandHome } from './utils.js';
import { note, section, skipped, verboseStatus, warn } from './ui.js';
import type { ExistingConfig } from './types.js';

export interface CliCommandConfig {
  cliBinDir: string | null;
  shellProfilePath: string | null;
}

export async function askCliCommandConfig(options: {
  prompt: PromptSession;
  existing: ExistingConfig;
  repoContext: boolean;
}): Promise<CliCommandConfig> {
  const {
    prompt,
    existing,
    repoContext,
  } = options;

  section('CLI command');
  const installCliCommand = await askYesNo(
    prompt,
    'Install `engram` command in a user bin directory?',
    true,
  );
  const defaultCliBinDir = existing.cliBinDir ?? getDefaultCliBinDir();
  const cliBinDir = installCliCommand
    ? expandHome(await askPathRequired(prompt, 'CLI bin directory', defaultCliBinDir, { kind: 'directory' }))
    : null;

  let { shellProfilePath } = existing;
  if (repoContext && cliBinDir !== null && !isDirectoryOnPath(cliBinDir) && shellProfilePath === null) {
    const detection = await detectShellProfile(null);
    const { path: detectedShellProfilePath } = detection;
    section('Shell profile PATH export');
    note(`Your selected CLI bin directory (${cliBinDir}) is not currently on PATH.`);
    if (await askYesNo(prompt, `Add it to PATH in ${detectedShellProfilePath}?`, true)) {
      shellProfilePath = expandHome(await askPathRequired(prompt, 'Shell profile path', detectedShellProfilePath, { kind: 'file' }));
    }
  }

  return { cliBinDir, shellProfilePath };
}

export async function ensureCliLauncher(options: {
  repoRoot: string;
  cliBinDir: string | null;
  shellProfilePath: string | null;
}): Promise<void> {
  const {
    repoRoot,
    cliBinDir,
    shellProfilePath,
  } = options;

  if (cliBinDir === null) {
    skipped('CLI launcher');
    return;
  }

  const result = await installCliLauncher({
    repoRoot,
    binDir: cliBinDir,
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    warn(`CLI launcher → failed (${message})`);
    return null;
  });
  if (result === null) return;

  switch (result.action) {
    case 'created':
    case 'updated':
    case 'unchanged':
      verboseStatus('CLI launcher', result.launcherPath, result.action);
      break;
    case 'conflict':
      warn(`CLI launcher → conflict at ${result.launcherPath}`);
      if (result.detail !== undefined) note(result.detail);
      break;
  }

  if (!isDirectoryOnPath(cliBinDir) && shellProfilePath === null) {
    warn(`CLI launcher hint: ${cliBinDir} is not on PATH in this shell.`);
    note('Add it to PATH or rerun init and enable shell profile exports.');
  }
}
