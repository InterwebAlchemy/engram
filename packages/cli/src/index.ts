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
  isVoicePreset,
  VOICE_PRESET_IDS,
  VOICE_PRESETS,
  type VoicePresetId,
  voicePresetEntries,
} from './voice-presets';
import {
  buildGitIdentity,
  expandHome,
  isChoice,
  isEnvKey,
  normalizeEngramRoot,
  parseGitIdentity,
  quoteForShell,
  replaceSection,
  stripQuotes,
} from './utils';

type HarnessKey =
  | 'claudeCode'
  | 'claudeDesktop'
  | 'cursor'
  | 'vscode'
  | 'copilot'
  | 'windsurf';

interface HarnessOption {
  key: HarnessKey;
  label: string;
  envKey: string;
  description: string;
}

interface ExistingConfig {
  vaultPath: string;
  engramRoot: string;
  agentName: string;
  gitName: string;
  gitEmail: string;
  harnesses: Record<HarnessKey, boolean>;
  claudeCodeScope: 'local' | 'user';
  voicePreset: VoicePresetId;
}

interface CliAnswers {
  agentName: string;
  gitName: string;
  gitEmail: string;
  vaultPath: string;
  engramRoot: string;
  harnesses: Record<HarnessKey, boolean>;
  claudeCodeScope: 'local' | 'user';
  voicePreset: VoicePresetId;
  runSetup: boolean;
}

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
];

const CLI_ARG_START_INDEX = 2;
const REPO_ROOT_SEGMENTS_UP = '../../..';
const NOTE_PREVIEW_SEPARATOR = '\n';
const DEFAULT_ENGRAM_ROOT = 'engram';
const DEFAULT_AGENT_NAME = 'gl1tch';
const DEFAULT_CLAUDE_CODE_SCOPE = 'local';
const TRUE_VALUE = 'true';
const FALSE_VALUE = 'false';
const ENV_ASSIGNMENT_SEPARATOR = '=';
const CARRIAGE_RETURN_PATTERN = /\r?\n/gv;

function writeLine(message = ''): void {
  output.write(`${message}\n`);
}

function writeError(message: string): void {
  stderr.write(`${message}\n`);
}

function createEmptyHarnessSelections(): Record<HarnessKey, boolean> {
  return {
    claudeCode: false,
    claudeDesktop: false,
    cursor: false,
    vscode: false,
    copilot: false,
    windsurf: false,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(argv.slice(CLI_ARG_START_INDEX));
  if (args.help) {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(__dirname, REPO_ROOT_SEGMENTS_UP);
  const envPath = path.join(repoRoot, '.env');
  const templatePath = path.join(repoRoot, 'templates', 'soul-template.md');
  const existing = await loadExistingConfig(envPath, repoRoot);
  const rl = readline.createInterface({ input, output });

  try {
    writeLine('Engram CLI');
    writeLine();
    writeLine('This will write local setup values to .env, scaffold a Soul document, and optionally run setup.');
    writeLine();

    const answers = await askQuestions(rl, existing);
    const envUpdates = buildEnvUpdates(answers);

    await upsertEnvFile(envPath, envUpdates);
    const envDisplayPath = path.relative(repoRoot, envPath);
    writeLine(`Updated ${envDisplayPath.length > 0 ? envDisplayPath : '.env'}`);

    if (answers.runSetup) {
      await runSetup(repoRoot, answers.vaultPath, answers.engramRoot);
    }

    await writeSoulDocument(templatePath, answers);

    writeLine();
    writeLine('CLI scaffold complete.');
    writeLine(`Vault: ${answers.vaultPath}`);
    writeLine(`Engram root: ${answers.engramRoot}`);
    writeLine(`Soul: ${path.join(answers.vaultPath, answers.engramRoot, 'memory', 'reflections', 'soul.md')}`);
    writeLine();
    writeLine('Next steps:');
    writeLine('1. Review the generated Soul document and make it yours.');
    writeLine('2. Open the vault in Obsidian and enable the Engram plugin if you have not already.');
    writeLine('3. Start a session in a configured harness and use "load your engram" if bootstrap does not happen on greeting.');
  } finally {
    rl.close();
  }
}

function parseArgs(argv: string[]): { help: boolean } {
  return {
    help: argv.includes('--help') || argv.includes('-h'),
  };
}

async function askQuestions(
  rl: readline.Interface,
  existing: ExistingConfig,
): Promise<CliAnswers> {
  const agentName = await askRequired(rl, 'Engram name', existing.agentName);
  const gitName = await ask(rl, 'Git identity name (optional)', existing.gitName);
  const gitEmail = await ask(rl, 'Git identity email (optional)', existing.gitEmail);
  const vaultPath = await askRequired(rl, 'Obsidian vault path', existing.vaultPath);
  const engramRoot = normalizeEngramRoot(
    await askRequired(rl, 'Engram folder inside the vault', existing.engramRoot),
  );

  writeLine();
  writeLine('Harness setup');
  const harnesses = await askHarnesses(rl, existing);

  let claudeCodeScope: 'local' | 'user' = existing.claudeCodeScope;
  if (harnesses.claudeCode) {
    claudeCodeScope = await askChoice(
      rl,
      'Claude Code scope',
      ['local', 'user'],
      existing.claudeCodeScope,
    );
  }

  writeLine();
  writeLine('Voice preset');
  for (const [id, preset] of voicePresetEntries()) {
    writeLine(`- ${id}: ${preset.label} — ${preset.description}`);
  }
  const voicePreset = await askChoice(
    rl,
    'Starter voice preset',
    VOICE_PRESET_IDS,
    existing.voicePreset,
  );

  const runSetup = await askYesNo(rl, 'Run setup now?', true);

  return {
    agentName,
    gitName,
    gitEmail,
    vaultPath: expandHome(vaultPath),
    engramRoot,
    harnesses,
    claudeCodeScope,
    voicePreset,
    runSetup,
  };
}

async function askHarnesses(
  rl: readline.Interface,
  existing: ExistingConfig,
  index = 0,
  selections: Record<HarnessKey, boolean> = createEmptyHarnessSelections(),
): Promise<Record<HarnessKey, boolean>> {
  const harness = HARNESSES.at(index);
  if (harness === undefined) {
    return selections;
  }

  writeLine(`- ${harness.label}: ${harness.description}`);
  const enabled = await askYesNo(rl, `Configure ${harness.label}?`, existing.harnesses[harness.key]);
  return await askHarnesses(rl, existing, index + 1, {
    ...selections,
    [harness.key]: enabled,
  });
}

async function loadExistingConfig(envPath: string, repoRoot: string): Promise<ExistingConfig> {
  const env = await readEnvFile(envPath);
  const gitIdentity = parseGitIdentity(env.GIT_IDENTITY ?? env.ENGRAM_GIT_IDENTITY ?? '');
  const vaultPath = env.ENGRAM_VAULT_PATH ?? path.join(repoRoot, 'tmp', 'vault');
  const engramRoot = env.ENGRAM_ROOT ?? DEFAULT_ENGRAM_ROOT;
  const agentName = env.ENGRAM_NAME ?? DEFAULT_AGENT_NAME;

  return {
    vaultPath: expandHome(vaultPath),
    engramRoot: normalizeEngramRoot(engramRoot),
    agentName,
    gitName: gitIdentity.name,
    gitEmail: gitIdentity.email,
    harnesses: {
      claudeCode: env.MCP_CONFIGURE_CLAUDE_CODE === TRUE_VALUE,
      claudeDesktop: env.MCP_CONFIGURE_CLAUDE_DESKTOP === TRUE_VALUE,
      cursor: env.MCP_CONFIGURE_CURSOR === TRUE_VALUE,
      vscode: env.MCP_CONFIGURE_VSCODE === TRUE_VALUE,
      copilot: env.MCP_CONFIGURE_COPILOT === TRUE_VALUE,
      windsurf: env.MCP_CONFIGURE_WINDSURF === TRUE_VALUE,
    },
    claudeCodeScope: env.MCP_CLAUDE_CODE_SCOPE === 'user' ? 'user' : DEFAULT_CLAUDE_CODE_SCOPE,
    voicePreset: isVoicePreset(env.ENGRAM_VOICE_PRESET) ? env.ENGRAM_VOICE_PRESET : 'collaborator',
  };
}

async function readEnvFile(envPath: string): Promise<Partial<Record<string, string>>> {
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    const entries: Partial<Record<string, string>> = {};

    for (const line of raw.split(CARRIAGE_RETURN_PATTERN)) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

      const index = trimmed.indexOf(ENV_ASSIGNMENT_SEPARATOR);
      if (index === -1) continue;

      const key = trimmed.slice(0, index).trim();
      const value = trimmed.slice(index + 1).trim();
      entries[key] = stripQuotes(value);
    }

    return entries;
  } catch {
    return {};
  }
}

function buildEnvUpdates(answers: CliAnswers): Record<string, string> {
  const gitIdentity = buildGitIdentity(answers.gitName, answers.gitEmail);
  const updates: Record<string, string> = {
    ENGRAM_NAME: answers.agentName,
    ENGRAM_VAULT_PATH: answers.vaultPath,
    ENGRAM_ROOT: answers.engramRoot,
    ENGRAM_VOICE_PRESET: answers.voicePreset,
    GIT_IDENTITY: gitIdentity,
    ENGRAM_GIT_IDENTITY: gitIdentity,
    MCP_CLAUDE_CODE_SCOPE: answers.claudeCodeScope,
  };

  for (const harness of HARNESSES) {
    updates[harness.envKey] = answers.harnesses[harness.key] ? TRUE_VALUE : FALSE_VALUE;
  }

  return updates;
}

async function upsertEnvFile(envPath: string, updates: Record<string, string>): Promise<void> {
  const existing = await fs.readFile(envPath, 'utf8').catch(() => '');
  const lines = existing.length > 0 ? existing.split(CARRIAGE_RETURN_PATTERN) : [];
  const pending = new Map(Object.entries(updates));
  const nextLines = lines.map((line) => {
    const separatorIndex = line.indexOf(ENV_ASSIGNMENT_SEPARATOR);
    if (separatorIndex === -1) return line;
    const key = line.slice(0, separatorIndex);
    if (!isEnvKey(key)) return line;
    if (!pending.has(key)) return line;

    const value = pending.get(key) ?? '';
    pending.delete(key);
    return `${key}=${quoteForShell(value)}`;
  });

  if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') {
    nextLines.push('');
  }

  for (const [key, value] of pending) {
    nextLines.push(`${key}=${quoteForShell(value)}`);
  }

  const outputContent = `${nextLines.join(NOTE_PREVIEW_SEPARATOR).replace(/\n{3,}/gv, '\n\n').trimEnd()}\n`;
  await fs.writeFile(envPath, outputContent, 'utf8');
}

async function runSetup(repoRoot: string, vaultPath: string, engramRoot: string): Promise<void> {
  const child = spawn('bash', ['scripts/setup-dev.sh', vaultPath], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      ENGRAM_VAULT_PATH: vaultPath,
      ENGRAM_ROOT: engramRoot,
    },
  });

  const exitPromise = once(child, 'exit');
  const errorPromise = once(child, 'error').then(([error]) => {
    throw error instanceof Error ? error : new Error(String(error));
  });
  const exitResult: unknown = await Promise.race([exitPromise, errorPromise]);
  const code = exitCodeFromResult(exitResult);
  if (code !== 0) {
    throw new Error(`setup-dev.sh exited with code ${code ?? 'unknown'}`);
  }
}

async function writeSoulDocument(
  templatePath: string,
  answers: CliAnswers,
): Promise<void> {
  const template = await fs.readFile(templatePath, 'utf8');
  const soulPath = path.join(
    answers.vaultPath,
    answers.engramRoot,
    'memory',
    'reflections',
    'soul.md',
  );
  const {
    agentName,
    gitEmail,
    gitName,
    voicePreset,
  } = answers;
  const { [voicePreset]: preset } = VOICE_PRESETS;
  const {
    bootSignature,
    howIApproachProblems,
    howICommunicate,
    values,
    voiceGuardrails,
    voiceprint,
  } = preset;
  const gitIdentity = buildGitIdentity(gitName, gitEmail);

  let content = template.replaceAll('[your agent name]', agentName);
  content = gitIdentity.length > 0
    ? content.replace(
      /# git_identity: your-agent-name <your-agent@example\.com>/v,
      `git_identity: ${gitIdentity}`,
    )
    : content;
  content = replaceSection(content, 'How I Approach Problems', howIApproachProblems);
  content = replaceSection(content, 'How I Communicate', howICommunicate);
  content = replaceSection(content, 'Voiceprint', voiceprint);
  content = replaceSection(content, 'Boot Signature', bootSignature);
  content = replaceSection(content, 'Voice Guardrails', voiceGuardrails);
  content = replaceSection(
    content,
    'Values I Want to Hold',
    values.map((value) => `- ${value}`).join('\n'),
  );

  await fs.mkdir(path.dirname(soulPath), { recursive: true });
  await fs.writeFile(soulPath, content, 'utf8');
}

async function ask(rl: readline.Interface, label: string, defaultValue = ''): Promise<string> {
  const suffix = defaultValue.length > 0 ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer.length > 0 ? answer : defaultValue;
}

async function askRequired(
  rl: readline.Interface,
  label: string,
  defaultValue = '',
): Promise<string> {
  const answer = await ask(rl, label, defaultValue);
  return answer.trim().length > 0 ? answer.trim() : await askRequired(rl, label, defaultValue);
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

async function askChoice<T extends string>(
  rl: readline.Interface,
  label: string,
  options: readonly T[],
  defaultValue: T,
): Promise<T> {
  const defaultSuffix = defaultValue.length > 0 ? ` (${defaultValue})` : '';
  const answer = (await rl.question(
    `${label} [${options.join('/')}]${defaultSuffix}: `,
  )).trim().toLowerCase();
  if (answer.length === 0) return defaultValue;
  return isChoice(options, answer) ? answer : await askChoice(rl, label, options, defaultValue);
}

function exitCodeFromResult(result: unknown): number | null {
  if (!isUnknownArray(result)) {
    throw new Error('setup-dev.sh exited without an exit result');
  }
  const rawCode = result.at(0);
  return typeof rawCode === 'number' || rawCode === null ? rawCode : null;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function printHelp(): void {
  writeLine('Usage: npm run cli');
  writeLine('       engram-cli');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeError(`CLI failed: ${message}`);
  exit(1);
});
