#!/usr/bin/env node

import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import {
  argv,
  exit,
  stderr,
  stdin as input,
  stdout as output,
} from 'node:process';
import {
  VOICE_PRESET_IDS,
  voicePresetEntries,
} from './voice-presets';
import {
  expandHome,
  isChoice,
  normalizeEngramRoot,
} from './utils';
import type { Placement } from './markers';
import {
  getBootstrapFileInfo,
  installObsidianPlugin,
  injectBootstrap,
  writeCopilotInstructions,
  configureWindsurfMcp,
  injectWindsurfGlobalRules,
  configureOpencodeMcp,
  injectOpencodeGlobalRules,
} from './harness-config';
import { buildEnvUpdates } from './env-file';
import {
  loadExistingConfig,
  getDefaultSnapshotDir,
  isRepoContext,
} from './config';
import { runRemove } from './remove';
import {
  detectShellProfile,
} from './shell-profile';
import { maybeCreatePreflightSnapshot } from './init-preflight-snapshot';
import { persistInitState, printInitMode } from './init-state';
import { syncSoulDocument } from './soul-sync';
import type { ExistingConfig, HarnessOption, InitAnswers } from './types';

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
];

const CLI_ARG_START_INDEX = 2;
const REPO_ROOT_SEGMENTS_UP = '../../..';
const OBSIDIAN_PLUGIN_FILES = ['main.js', 'manifest.json', 'styles.css'] as const;
const OBSIDIAN_PLUGIN_PACKAGE_RELATIVE = '../obsidian-plugin';

// ── Output helpers ──────────────────────────────────────────────────────────

function writeLine(message = ''): void {
  output.write(`${message}\n`);
}

function writeError(message: string): void {
  stderr.write(`${message}\n`);
}

// ── Subcommand dispatch ─────────────────────────────────────────────────────

function parseArgs(args: string[]): 'init' | 'remove' | 'help' {
  if (args.includes('--help') || args.includes('-h') || args.includes('help')) return 'help';
  if (args.includes('remove') || args.includes('uninstall')) return 'remove';
  return 'init';
}

async function main(): Promise<void> {
  const command = parseArgs(argv.slice(CLI_ARG_START_INDEX));
  const repoRoot = path.resolve(__dirname, REPO_ROOT_SEGMENTS_UP);
  const envPath = path.join(repoRoot, '.env');
  const repoContext = await isRepoContext(repoRoot);

  switch (command) {
    case 'help':
      printHelp();
      break;
    case 'init':
      await runInit(repoRoot, envPath, repoContext);
      break;
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

async function runInit(repoRoot: string, envPath: string, repoContext: boolean): Promise<void> {
  const templatePath = path.join(repoRoot, 'templates', 'soul-template.md');
  const agentsTemplatePath = path.join(repoRoot, 'templates', 'engram-bootstrap.tmpl.md');
  const existing = await loadExistingConfig(envPath, repoRoot);
  const rl = readline.createInterface({ input, output });

  try {
    writeLine('Engram CLI — init');
    writeLine();
    printInitMode(existing, repoContext);
    writeLine();

    const answers = await askInitQuestions(rl, existing, repoContext);
    await maybeCreatePreflightSnapshot(repoRoot, existing, answers, rl);
    const envUpdates = buildEnvUpdates(answers, HARNESSES);
    await persistInitState({ answers, envPath, existing, repoContext, repoRoot, harnesses: HARNESSES });

    if (answers.runSetup) {
      await runSetup({
        repoRoot,
        vaultPath: answers.vaultPath,
        engramRoot: answers.engramRoot,
        installObsidianPluginNow: answers.installObsidianPlugin,
        envUpdates,
      });
    } else if (answers.installObsidianPlugin) {
      await installPluginFromCli(repoRoot, answers.vaultPath);
    }

    await syncSoulDocument(templatePath, answers, rl);
    const mcpScriptPath = path.join(repoRoot, 'scripts', 'mcp.sh');
    await injectBootstrapFiles(agentsTemplatePath, mcpScriptPath, answers);

    writeLine();
    writeLine('Init complete.');
    writeLine(`Vault: ${answers.vaultPath}`);
    writeLine(`Engram root: ${answers.engramRoot}`);
    writeLine(`Soul: ${path.join(answers.vaultPath, answers.engramRoot, 'memory', 'reflections', 'soul.md')}`);
    writeLine();
    writeLine('Next steps:');
    writeLine('1. Review the generated Soul document and make it yours.');
    if (answers.installObsidianPlugin) {
      writeLine('2. Open the vault in Obsidian and enable the Engram plugin if you have not already.');
    } else if (repoContext && answers.runSetup) {
      writeLine('2. Plugin install was skipped. Rerun init later if you want to install it into this vault.');
    } else if (repoContext) {
      writeLine('2. Run the repo setup later when you are ready to scaffold the dev vault and plugin wiring.');
    } else {
      writeLine('2. If you want shell-level access to the saved env vars later, rerun init and enable shell profile exports.');
    }
    writeLine('3. Start a session in a configured harness and use "load your engram" if bootstrap does not happen on greeting.');
  } finally {
    rl.close();
  }
}

async function injectBootstrapFiles(
  agentsTemplatePath: string,
  mcpScriptPath: string,
  answers: InitAnswers,
): Promise<void> {
  const agentsTemplate = await fs.readFile(agentsTemplatePath, 'utf8').catch(() => null);
  if (agentsTemplate === null) return;

  if (answers.harnesses.claudeCode && answers.claudeCodeScope === 'user') {
    const result = await injectBootstrap(agentsTemplate, answers.bootstrapPlacement);
    writeLine(`Bootstrap → ${result.path} (${result.action})`);
  }

  if (answers.harnesses.copilot) {
    const instrPath = await writeCopilotInstructions(agentsTemplate);
    writeLine(`Bootstrap → ${instrPath}`);
  }

  if (answers.harnesses.windsurf) {
    const mcpPath = await configureWindsurfMcp(mcpScriptPath);
    writeLine(`MCP config → ${mcpPath}`);
    const rulesResult = await injectWindsurfGlobalRules(agentsTemplate);
    writeLine(`Bootstrap → ${rulesResult.path} (${rulesResult.action})`);
  }

  if (answers.harnesses.opencode) {
    const mcpPath = await configureOpencodeMcp(mcpScriptPath);
    writeLine(`MCP config → ${mcpPath}`);
    const rulesResult = await injectOpencodeGlobalRules(agentsTemplate);
    writeLine(`Bootstrap → ${rulesResult.path} (${rulesResult.action})`);
  }
}

// ── Init questions ──────────────────────────────────────────────────────────

async function askInitQuestions(
  rl: readline.Interface,
  existing: ExistingConfig,
  repoContext: boolean,
): Promise<InitAnswers> {
  const agentName = await askRequired(rl, 'Engram name', existing.agentName);
  const gitName = await ask(rl, 'Git identity name (optional)', existing.gitName);
  const gitEmail = await ask(rl, 'Git identity email (optional)', existing.gitEmail);
  const vaultPath = await askRequired(rl, 'Obsidian vault path', existing.vaultPath);
  const engramRoot = normalizeEngramRoot(
    await askRequired(rl, 'Engram folder inside the vault', existing.engramRoot),
  );
  const snapshotDir = expandHome(
    await askRequired(rl, 'Snapshot directory', existing.snapshotDir.length > 0 ? existing.snapshotDir : getDefaultSnapshotDir()),
  );

  writeLine();
  writeLine('Harness setup');
  const harnesses = await askHarnesses(rl, existing);

  let claudeCodeScope: 'local' | 'user' = existing.claudeCodeScope;
  if (harnesses.claudeCode) {
    claudeCodeScope = await askChoice(rl, 'Claude Code scope', ['local', 'user'], existing.claudeCodeScope);
  }

  const bootstrapPlacement = await askBootstrapPlacement(rl, harnesses, claudeCodeScope);

  writeLine();
  writeLine('Voice preset');
  for (const [id, preset] of voicePresetEntries()) {
    writeLine(`- ${id}: ${preset.label} — ${preset.description}`);
  }
  const voicePreset = await askChoice(rl, 'Starter voice preset', VOICE_PRESET_IDS, existing.voicePreset);

  let { shellProfilePath } = existing;
  if (!repoContext) {
    const detection = await detectShellProfile(existing.shellProfilePath);
    const { path: detectedShellProfilePath } = detection;
    writeLine();
    writeLine('Shell profile exports');
    writeLine('Instead of writing a project-local .env, Engram can manage exports in your shell profile.');
    const shouldWriteShellExports = await askYesNo(
      rl,
      `Write Engram exports to ${detectedShellProfilePath}?`,
      existing.shellProfilePath !== null,
    );
    if (shouldWriteShellExports) {
      shellProfilePath = expandHome(await askRequired(rl, 'Shell profile path', detectedShellProfilePath));
    } else {
      shellProfilePath = null;
    }
  }

  const runSetup = repoContext
    ? await askYesNo(rl, 'Run repo setup now?', true)
    : false;

  writeLine();
  writeLine('Obsidian plugin');
  const installObsidianPluginNow = await askYesNo(rl, 'Install the Engram Obsidian plugin into this vault now?', true);

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
    runSetup,
    installObsidianPlugin: installObsidianPluginNow,
  };
}

async function askBootstrapPlacement(
  rl: readline.Interface,
  harnesses: Record<string, boolean>,
  claudeCodeScope: string,
): Promise<Placement> {
  const needsFile = harnesses.claudeCode && claudeCodeScope === 'user';
  if (!needsFile) return 'bottom';

  const info = await getBootstrapFileInfo();
  if (!info.exists || info.hasMarkers) return 'bottom';

  writeLine();
  writeLine(`Your ${info.path} already has content.`);
  writeLine('The Engram bootstrap will be wrapped in markers so it can be updated or removed later.');
  return await askChoice(rl, 'Bootstrap placement', ['top', 'bottom'], 'bottom');
}

async function askHarnesses(
  rl: readline.Interface,
  existing: ExistingConfig,
  index = 0,
  selections = createEmptyHarnessSelections(),
): Promise<Record<string, boolean>> {
  const harness = HARNESSES.at(index);
  if (harness === undefined) return selections;

  writeLine(`- ${harness.label}: ${harness.description}`);
  const enabled = await askYesNo(rl, `Configure ${harness.label}?`, existing.harnesses[harness.key]);
  return await askHarnesses(rl, existing, index + 1, { ...selections, [harness.key]: enabled });
}

function createEmptyHarnessSelections(): Record<string, boolean> {
  return { claudeCode: false, claudeDesktop: false, cursor: false, vscode: false, copilot: false, windsurf: false, opencode: false };
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
    stdio: 'inherit',
    env: {
      ...process.env,
      ...envUpdates,
      ENGRAM_VAULT_PATH: vaultPath,
      ENGRAM_ROOT: engramRoot,
      ENGRAM_INSTALL_OBSIDIAN_PLUGIN: installObsidianPluginNow ? 'true' : 'false',
    },
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
    throw new Error(`setup-dev.sh exited with code ${codeStr}`);
  }
}

async function installPluginFromCli(repoRoot: string, vaultPath: string): Promise<void> {
  const sourcePluginDir = await resolveObsidianPluginSource(repoRoot);
  if (sourcePluginDir === null) {
    writeLine('Obsidian plugin install skipped (plugin assets not found near this CLI build).');
    return;
  }

  const actions = await installObsidianPlugin(vaultPath, sourcePluginDir);
  for (const action of actions) {
    writeLine(`Plugin install → ${action}`);
  }
}

async function resolveObsidianPluginSource(repoRoot: string): Promise<string | null> {
  const repoPluginDir = path.join(repoRoot, 'packages', 'obsidian-plugin');
  if (await hasPluginAssets(repoPluginDir)) return repoPluginDir;

  const packagedPluginDir = path.resolve(__dirname, OBSIDIAN_PLUGIN_PACKAGE_RELATIVE);
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

// ── Prompt helpers ──────────────────────────────────────────────────────────

async function ask(rl: readline.Interface, label: string, defaultValue = ''): Promise<string> {
  const suffix = defaultValue.length > 0 ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer.length > 0 ? answer : defaultValue;
}

async function askRequired(rl: readline.Interface, label: string, defaultValue = ''): Promise<string> {
  const answer = await ask(rl, label, defaultValue);
  return answer.trim().length > 0 ? answer.trim() : await askRequired(rl, label, defaultValue);
}

async function askYesNo(rl: readline.Interface, label: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
  const answer = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
  if (answer.length === 0) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

async function askChoice<T extends string>(
  rl: readline.Interface,
  label: string,
  options: readonly T[],
  defaultValue: T,
): Promise<T> {
  const defaultSuffix = defaultValue.length > 0 ? ` (${defaultValue})` : '';
  const answer = (await rl.question(`${label} [${options.join('/')}]${defaultSuffix}: `)).trim().toLowerCase();
  if (answer.length === 0) return defaultValue;
  return isChoice(options, answer) ? answer : await askChoice(rl, label, options, defaultValue);
}

function printHelp(): void {
  for (const line of ['Usage: engram-cli [command]', '', 'Commands:', '  init      Set up a new Engram (default)', '  remove    Remove Engram integrations and optionally delete vault data', '  help      Show this help message']) writeLine(line);
}
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeError(`CLI failed: ${message}`);
  exit(1);
});
