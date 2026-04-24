#!/usr/bin/env node

import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { argv, exit, stderr, stdin as input, stdout as output } from 'node:process';
import { VOICE_PRESET_IDS, voicePresetEntries } from './voice-presets.js';
import { expandHome, normalizeEngramRoot } from './utils.js';
import type { Placement } from './markers.js';
import { getBootstrapFileInfo, installObsidianPlugin } from './harness-config.js';
import { buildEnvUpdates } from './env-file.js';
import { loadExistingConfig, getDefaultSnapshotDir, isRepoContext } from './config.js';
import { runRemove } from './remove.js';
import * as readline from 'node:readline/promises';
import { askHarnesses } from './harness-prompts.js';
import { detectShellProfile } from './shell-profile.js';
import { askCliCommandConfig, ensureCliLauncher } from './cli-command.js';
import { maybeCreatePreflightSnapshot } from './init-preflight-snapshot.js';
import { persistInitState, printInitMode } from './init-state.js';
import { syncSoulDocument } from './soul-sync.js';
import {
  bullet,
  clearScreen,
  muted,
  note,
  printBanner,
  printInitSummary,
  section,
  setVerbose,
  skipped,
  status,
  subheading,
  writeLine,
} from './ui.js';
import { runHarnessSetupStage } from './harness-setup.js';
import { resolveRepoRootFromEntrypoint, resolveRuntimeDirFromEntrypoint } from './runtime-paths.js';
import {
  ask,
  askPathRequired,
  askSubdirOf,
  askChoice,
  askRequired,
  askYesNo,
  closePromptSession,
  createPromptSession,
  type PromptSession,
} from './prompt-helpers.js';
import type { ExistingConfig, HarnessOption, InitAnswers } from './types.js';

// ── Constants ───────────────────────────────────────────────────────────────

const HARNESSES: HarnessOption[] = [
  {
    key: 'claudeCode',
    label: 'Claude Code',
    envKey: 'MCP_CONFIGURE_CLAUDE_CODE',
    description: 'Adds the Engram MCP server to Claude Code.',
  },
  {
    key: 'claudeDesktop',
    label: 'Claude Desktop',
    envKey: 'MCP_CONFIGURE_CLAUDE_DESKTOP',
    description: 'Writes Claude Desktop MCP config.',
  },
  {
    key: 'cursor',
    label: 'Cursor',
    envKey: 'MCP_CONFIGURE_CURSOR',
    description: 'Writes Cursor MCP config and copies bootstrap instructions.',
  },
  {
    key: 'vscode',
    label: 'VS Code',
    envKey: 'MCP_CONFIGURE_VSCODE',
    description: 'Registers the MCP server in VS Code user settings.',
  },
  {
    key: 'zed',
    label: 'Zed',
    envKey: 'MCP_CONFIGURE_ZED',
    description: 'Registers MCP in Zed settings and guides UI paste of bootstrap instructions.',
  },
  {
    key: 'copilot',
    label: 'GitHub Copilot',
    envKey: 'MCP_CONFIGURE_COPILOT',
    description: 'Configures MCP plus Copilot instruction files.',
  },
  {
    key: 'windsurf',
    label: 'Windsurf',
    envKey: 'MCP_CONFIGURE_WINDSURF',
    description: 'Registers the MCP server in Windsurf.',
  },
  {
    key: 'opencode',
    label: 'OpenCode',
    envKey: 'MCP_CONFIGURE_OPENCODE',
    description: 'Configures MCP server in OpenCode config and adds bootstrap rules.',
  },
  {
    key: 'agentsSkills',
    label: 'Agent Skills',
    envKey: 'ENGRAM_CONFIGURE_AGENTS_SKILLS',
    description: 'Installs Engram Agent Skills to ~/.agents/skills for Agent Skills harnesses (for example, Pi).',
  },
];

const CLI_ARG_START_INDEX = 2;
const OBSIDIAN_PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'] as const;
const OBSIDIAN_PLUGIN_PACKAGE_RELATIVE = '../obsidian-plugin';

// ── Output helpers ──────────────────────────────────────────────────────────

function writeError(message: string): void {
  stderr.write(`${message}\n`);
}

// ── Subcommand dispatch ─────────────────────────────────────────────────────

function parseArgs(args: string[]): 'init' | 'remove' | 'help' {
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) return 'help';
  if (args.includes('remove') || args.includes('uninstall')) return 'remove';
  return 'init';
}

function hasVerboseFlag(args: readonly string[]): boolean {
  return args.includes('--verbose') || args.includes('-v');
}

async function main(): Promise<void> {
  const args = argv.slice(CLI_ARG_START_INDEX);
  const command = parseArgs(args);
  const verbose = hasVerboseFlag(args);
  setVerbose(verbose);
  const repoRoot = resolveRepoRootFromEntrypoint();
  const envPath = path.join(repoRoot, '.env');
  const repoContext = await isRepoContext(repoRoot);

  switch (command) {
    case 'help':
      printHelp();
      break;
    case 'init': {
      const prompt = createPromptSession();
      try {
        await runInit({
          repoRoot,
          envPath,
          repoContext,
          prompt,
          verbose,
        });
      } finally {
        closePromptSession(prompt);
      }
      break;
    }
    case 'remove': {
      const existing = await loadExistingConfig(envPath, repoRoot);
      const rl = readline.createInterface({ input, output });
      try {
        await runRemove({ rl, existing, harnesses: HARNESSES, repoRoot, envPath, repoContext });
      } finally {
        rl.close();
      }
      break;
    }
  }
}

// ── Init command ────────────────────────────────────────────────────────────

interface RunInitOptions {
  repoRoot: string;
  envPath: string;
  repoContext: boolean;
  prompt: PromptSession;
  verbose: boolean;
}

async function runInit(options: RunInitOptions): Promise<void> {
  const {
    repoRoot,
    envPath,
    repoContext,
    prompt,
    verbose,
  } = options;
  const templatePath = path.join(repoRoot, 'templates', 'soul-template.md');
  const existing = await loadExistingConfig(envPath, repoRoot);

  printBanner('Interactive setup');
  section('Configure your Engram');
  printInitMode(existing, repoContext);

  const answers = await askInitQuestions(prompt, existing, repoContext);
  clearScreen('Apply Configuration', { step: 1, total: 2 });
  await maybeCreatePreflightSnapshot(repoRoot, existing, answers, prompt);
  const envUpdates = buildEnvUpdates(answers, HARNESSES);
  await persistInitState({ answers, envPath, existing, repoContext, repoRoot, harnesses: HARNESSES });
  await ensureCliLauncher({
    repoRoot,
    cliBinDir: answers.cliBinDir,
    shellProfilePath: answers.shellProfilePath,
  });

  if (answers.runSetup) {
    subheading('Running repo setup…');
    await runSetup({
      repoRoot,
      vaultPath: answers.vaultPath,
      engramRoot: answers.engramRoot,
      installObsidianPluginNow: answers.installObsidianPlugin,
      envUpdates,
    });
    status('Repo setup', 'complete', 'setup-dev.sh');
  } else if (answers.installObsidianPlugin) {
    await installPluginFromCli(repoRoot, answers.vaultPath);
  }

  const mcpScriptPath = path.join(repoRoot, 'scripts', 'mcp.sh');
  await runHarnessSetupStage({
    repoRoot,
    mcpScriptPath,
    answers,
    prompt,
    verbose,
  });

  clearScreen('Finalize Engram', { step: 2, total: 2 });
  await syncSoulDocument(templatePath, answers, prompt);
  printInitSummary(answers, repoContext);
}

// ── Init questions ──────────────────────────────────────────────────────────

async function askInitQuestions(
  prompt: PromptSession,
  existing: ExistingConfig,
  repoContext: boolean,
): Promise<InitAnswers> {
  const agentName = await askRequired(prompt, 'Engram name', existing.agentName);
  const gitName = await ask(prompt, 'Git identity name (optional)', existing.gitName);
  const gitEmail = await ask(prompt, 'Git identity email (optional)', existing.gitEmail);
  const vaultPath = await askPathRequired(prompt, 'Obsidian vault path', existing.vaultPath, { kind: 'directory' });
  const engramRoot = normalizeEngramRoot(
    await askSubdirOf(prompt, 'Engram folder inside the vault', expandHome(vaultPath), existing.engramRoot),
  );
  const snapshotDir = expandHome(
    await askPathRequired(
      prompt,
      'Snapshot directory',
      existing.snapshotDir.length > 0 ? existing.snapshotDir : getDefaultSnapshotDir(),
      { kind: 'directory' },
    ),
  );

  section('Harness setup');
  const harnesses = await askHarnesses(prompt, HARNESSES, existing);

  let claudeCodeScope: 'local' | 'user' = existing.claudeCodeScope;
  if (harnesses.claudeCode) {
    claudeCodeScope = await askChoice(prompt, 'Claude Code scope', ['local', 'user'], existing.claudeCodeScope);
  }

  const bootstrapPlacement = await askBootstrapPlacement(prompt, harnesses, claudeCodeScope);

  section('Voice preset');
  for (const [id, preset] of voicePresetEntries()) {
    bullet(`${muted(id)} — ${preset.label}: ${preset.description}`);
  }
  const voicePreset = await askChoice(prompt, 'Starter voice preset', VOICE_PRESET_IDS, existing.voicePreset);

  const cliConfig = await askCliCommandConfig({
    prompt,
    existing,
    repoContext,
  });
  const { cliBinDir } = cliConfig;
  let { shellProfilePath } = cliConfig;

  if (!repoContext) {
    const detection = await detectShellProfile(existing.shellProfilePath);
    const { path: detectedShellProfilePath } = detection;
    section('Shell profile exports');
    const shouldWriteShellExports = await askYesNo(
      prompt,
      'Write shell profile exports for Engram CLI variables?',
      existing.shellProfilePath !== null,
    );
    if (shouldWriteShellExports) {
      shellProfilePath = expandHome(
        await askPathRequired(prompt, 'Shell profile path', detectedShellProfilePath, { kind: 'file' }),
      );
    } else {
      shellProfilePath = null;
    }
  }

  const runSetup = repoContext
    ? await askYesNo(prompt, 'Run repo setup now?', true)
    : false;

  section('Obsidian plugin');
  const installObsidianPluginNow = await askYesNo(prompt, 'Install the Engram Obsidian plugin into this vault now?', true);

  return {
    agentName,
    gitName,
    gitEmail,
    vaultPath: expandHome(vaultPath),
    engramRoot,
    snapshotDir,
    harnesses,
    claudeCodeScope,
    bootstrapPlacement,
    voicePreset,
    shellProfilePath,
    cliBinDir,
    runSetup,
    installObsidianPlugin: installObsidianPluginNow,
  };
}

async function askBootstrapPlacement(
  prompt: PromptSession,
  harnesses: Record<string, boolean>,
  claudeCodeScope: string,
): Promise<Placement> {
  const needsFile = harnesses.claudeCode && claudeCodeScope === 'user';
  if (!needsFile) return 'bottom';

  const fileInfo = await getBootstrapFileInfo();
  if (!fileInfo.exists || fileInfo.hasMarkers) return 'bottom';

  subheading(`Your ${fileInfo.path} already has content.`);
  note('The Engram bootstrap will be wrapped in markers so it can be updated or removed later.');
  return await askChoice(prompt, 'Bootstrap placement', ['top', 'bottom'], 'bottom');
}

// ── Setup + Soul ────────────────────────────────────────────────────────────

async function runSetup(options: {
  repoRoot: string;
  vaultPath: string;
  engramRoot: string;
  installObsidianPluginNow: boolean;
  envUpdates: Record<string, string>;
}): Promise<void> {
  const {
    repoRoot,
    vaultPath,
    engramRoot,
    installObsidianPluginNow,
    envUpdates,
  } = options;
  const child = spawn('bash', ['scripts/setup-dev.sh', vaultPath], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...envUpdates,
      ENGRAM_VAULT_PATH: vaultPath,
      ENGRAM_ROOT: engramRoot,
      ENGRAM_INSTALL_OBSIDIAN_PLUGIN: installObsidianPluginNow ? 'true' : 'false',
      ENGRAM_SETUP_QUIET: 'true',
      MCP_CONFIGURE_CLAUDE_CODE: 'false',
      MCP_CONFIGURE_CLAUDE_DESKTOP: 'false',
      MCP_CONFIGURE_CURSOR: 'false',
      MCP_CONFIGURE_VSCODE: 'false',
      MCP_CONFIGURE_ZED: 'false',
      MCP_CONFIGURE_COPILOT: 'false',
      MCP_CONFIGURE_WINDSURF: 'false',
      MCP_CONFIGURE_OPENCODE: 'false',
      ENGRAM_CONFIGURE_AGENTS_SKILLS: 'false',
    },
  });

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  child.stdout.on('data', (chunk: Buffer | string) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
  });
  const exitPromise = once(child, 'exit');
  const errorPromise = once(child, 'error').then(([err]: unknown[]) => {
    throw err instanceof Error ? err : new Error(String(err));
  });
  const result: unknown = await Promise.race([exitPromise, errorPromise]);
  if (!Array.isArray(result)) throw new Error('setup-dev.sh exited without an exit result');
  const code: unknown = result.at(0);
  if (code !== 0) {
    const codeStr = typeof code === 'number' ? String(code) : 'unknown';
    const stderrOutput = stderrChunks.join('').trim();
    const stdoutOutput = stdoutChunks.join('').trim();
    const detail = stderrOutput.length > 0
      ? stderrOutput
      : stdoutOutput.length > 0
        ? stdoutOutput
        : 'no output captured';
    throw new Error(`setup-dev.sh exited with code ${codeStr}\n${detail}`);
  }
}

async function installPluginFromCli(repoRoot: string, vaultPath: string): Promise<void> {
  const sourcePluginDir = await resolveObsidianPluginSource(repoRoot);
  if (sourcePluginDir === null) {
    skipped('Obsidian plugin install', 'plugin assets not found near this CLI build');
    return;
  }

  const actions = await installObsidianPlugin(vaultPath, sourcePluginDir);
  for (const action of actions) {
    status('Plugin install', action);
  }
}

async function resolveObsidianPluginSource(repoRoot: string): Promise<string | null> {
  const repoPluginDir = path.join(repoRoot, 'packages', 'obsidian-plugin');
  if (await hasPluginAssets(repoPluginDir)) return repoPluginDir;

  const packagedPluginDir = path.resolve(resolveRuntimeDirFromEntrypoint(), OBSIDIAN_PLUGIN_PACKAGE_RELATIVE);
  if (await hasPluginAssets(packagedPluginDir)) return packagedPluginDir;

  return null;
}

async function hasPluginAssets(dirPath: string): Promise<boolean> {
  const checks = await Promise.all(
    OBSIDIAN_PLUGIN_FILES.map(async (fileName) => {
      const filePath = path.join(dirPath, fileName);
      try {
        await fs.access(filePath);
        return true;
      } catch {
        return false;
      }
    }),
  );
  return checks.every((check) => check);
}

function printHelp(): void {
  printBanner('Interactive setup');
  section('Usage');
  writeLine('  onboarding [command] [--verbose]');
  section('Commands');
  bullet(`${muted('init')}    Set up a new Engram (default)`);
  bullet(`${muted('remove')}  Remove Engram integrations and optionally delete vault data`);
  bullet(`${muted('help')}    Show this help message`);
  section('Options');
  bullet(`${muted('--verbose, -v')}  Show detailed setup output`);
  writeLine();
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeError(`CLI failed: ${message}`);
  exit(1);
});
