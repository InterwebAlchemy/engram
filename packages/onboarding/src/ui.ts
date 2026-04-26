import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { env, stdout } from 'node:process';

import boxen, { type Options as BoxenOptions } from 'boxen';
import chalk from 'chalk';
import logSymbols from 'log-symbols';
import ora, { type Options as OraOptions, type Ora } from 'ora';

import type { HarnessKey, InitAnswers } from './types.js';

const TAGLINE_PAD_DIVISOR = 2;
const SECTION_RULE_MAX = 60;
const SECTION_RULE_PREFIX = 4;
const SECTION_RULE_PADDING = 6;

// ── Verbosity ───────────────────────────────────────────────────────────────

let VERBOSE_ENABLED = false;

export function setVerbose(value: boolean): void {
  VERBOSE_ENABLED = value;
}

export function isVerbose(): boolean {
  return VERBOSE_ENABLED;
}

// ── Brand palette ───────────────────────────────────────────────────────────
//
// Teal primary, hot-pink accent, on whatever background the user's terminal has.
// Truecolor hex values map cleanly in modern terminals; chalk falls back on 256
// / 16-color terms automatically.

const TEAL = '#2EC4C4';
const TEAL_DIM = '#1F8A8A';
const PINK = '#F033A6';
const GRAY = '#8A8F98';

export const palette = {
  brand: chalk.hex(TEAL),
  brandDim: chalk.hex(TEAL_DIM),
  accent: chalk.hex(PINK),
  muted: chalk.hex(GRAY),
  bold: chalk.bold,
};

export const brand = (text: string): string => palette.brand(text);
export const accent = (text: string): string => palette.accent(text);
export const muted = (text: string): string => palette.muted(text);
export const bold = (text: string): string => palette.bold(text);

// ── Output primitives ───────────────────────────────────────────────────────

export function writeLine(message = ''): void {
  stdout.write(`${message}\n`);
  LAST_WAS_SECTION_RULE = false;
}

function writeLines(lines: readonly string[]): void {
  for (const line of lines) writeLine(line);
}

// ── Banner ──────────────────────────────────────────────────────────────────

const BANNER_LINES: readonly string[] = [
  '███████╗███╗   ██╗ ██████╗ ██████╗  █████╗ ███╗   ███╗',
  '██╔════╝████╗  ██║██╔════╝ ██╔══██╗██╔══██╗████╗ ████║',
  '█████╗  ██╔██╗ ██║██║  ███╗██████╔╝███████║██╔████╔██║',
  '██╔══╝  ██║╚██╗██║██║   ██║██╔══██╗██╔══██║██║╚██╔╝██║',
  '███████╗██║ ╚████║╚██████╔╝██║  ██║██║  ██║██║ ╚═╝ ██║',
  '╚══════╝╚═╝  ╚═══╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝',
];

const BANNER_TAGLINE = '◆ any agent. every harness. one engram ◆';

export function printBanner(subtitle?: string): void {
  writeLine();
  for (const line of BANNER_LINES) writeLine(palette.brand(line));
  const padded = BANNER_TAGLINE.padStart(
    Math.floor((BANNER_LINES[0].length + BANNER_TAGLINE.length) / TAGLINE_PAD_DIVISOR),
  );
  writeLine(palette.accent(padded));
  if (subtitle !== undefined && subtitle.length > 0) {
    writeLine();
    writeLine(palette.muted(`  ${subtitle}`));
  }
  writeLine();
}

// ── Sections ────────────────────────────────────────────────────────────────

export interface SectionOptions {
  step?: number;
  total?: number;
}

let LAST_WAS_SECTION_RULE = false;

function ensureSectionSpacing(): void {
  if (!LAST_WAS_SECTION_RULE) writeLine();
}

export function section(title: string, options: SectionOptions = {}): void {
  ensureSectionSpacing();
  const prefix = options.step !== undefined && options.total !== undefined
    ? palette.accent(`[${String(options.step)}/${String(options.total)}] `)
    : palette.accent('◆ ');
  writeLine(`${prefix}${palette.brand(palette.bold(title))}`);
  const ruleLength = Math.min(SECTION_RULE_MAX, SECTION_RULE_PREFIX + title.length + SECTION_RULE_PADDING);
  writeLine(palette.brandDim('─'.repeat(ruleLength)));
  LAST_WAS_SECTION_RULE = true;
}

export function subheading(title: string): void {
  writeLine();
  writeLine(palette.brandDim(`  ${title}`));
  LAST_WAS_SECTION_RULE = false;
}

export function clearScreen(title: string, options: SectionOptions = {}): void {
  if (!stdout.isTTY) {
    section(title, options);
    return;
  }
  if (env.ENGRAM_ONBOARDING_CLEAR_STAGES === 'false') {
    section(title, options);
    return;
  }
  stdout.write('\u001B[2J\u001B[H');
  printBanner();
  section(title, options);
}

// ── Status lines ────────────────────────────────────────────────────────────

export function info(message: string): void {
  writeLine(`${logSymbols.info} ${message}`);
}

export function success(message: string): void {
  writeLine(`${logSymbols.success} ${message}`);
}

export function warn(message: string): void {
  writeLine(`${logSymbols.warning} ${message}`);
}

export function error(message: string): void {
  writeLine(`${logSymbols.error} ${message}`);
}

export function bullet(message: string): void {
  writeLine(`  ${palette.accent('•')} ${message}`);
}

export function note(message: string): void {
  writeLine(palette.muted(`  ${message}`));
}

/**
 * Emits only when --verbose is set. For per-file paths, internal state
 * transitions, and other developer-debug details.
 */
export function verboseLine(message: string): void {
  if (VERBOSE_ENABLED) writeLine(palette.muted(`  ${message}`));
}

export function verboseStatus(target: string, detail: string, action?: string): void {
  if (VERBOSE_ENABLED) status(target, detail, action);
}

/**
 * Consistent "X → detail" status line. `action` optionally renders a tag
 * after the target in muted parens (e.g. "created", "updated", "unchanged").
 */
export function status(target: string, detail: string, action?: string): void {
  const arrow = palette.brand('→');
  const tag = action === undefined ? '' : palette.muted(` (${action})`);
  writeLine(`${logSymbols.success} ${palette.bold(target)} ${arrow} ${detail}${tag}`);
}

export function skipped(target: string, reason?: string): void {
  const tail = reason === undefined ? '' : palette.muted(` — ${reason}`);
  writeLine(`${logSymbols.info} ${palette.bold(target)} ${palette.muted('→ skipped')}${tail}`);
}

// ── Harness list items ──────────────────────────────────────────────────────

export type HarnessLineStatus = 'ok' | 'manual' | 'skipped' | 'failed';

export interface HarnessLineOptions {
  status: HarnessLineStatus;
  label: string;
  summary?: string;
  key?: HarnessKey;
}

const HARNESS_LABEL_WIDTH = 17;

export function harnessLine(options: HarnessLineOptions): void {
  const { status: lineStatus, label, summary } = options;
  const symbol = lineStatus === 'ok'
    ? logSymbols.success
    : lineStatus === 'manual'
      ? palette.accent('◐')
      : lineStatus === 'failed'
        ? logSymbols.error
        : logSymbols.info;
  const paddedLabel = label.padEnd(HARNESS_LABEL_WIDTH);
  const tail = summary === undefined || summary.length === 0
    ? ''
    : palette.muted(`  ${summary}`);
  writeLine(`  ${symbol} ${palette.bold(paddedLabel)}${tail}`);
}

// ── Spinner wrapper ─────────────────────────────────────────────────────────

export async function withSpinner<T>(
  text: string,
  task: (spinner: Ora) => Promise<T>,
  options: Partial<OraOptions> = {},
): Promise<T> {
  const spinner = ora({
    text,
    color: 'cyan',
    spinner: 'dots',
    ...options,
  }).start();
  try {
    const result = await task(spinner);
    if (spinner.isSpinning) spinner.succeed();
    return result;
  } catch (spinError) {
    if (spinner.isSpinning) spinner.fail();
    throw spinError;
  }
}

// ── Summary box ─────────────────────────────────────────────────────────────

export interface SummaryBoxOptions {
  title?: string;
  padding?: number;
  marginTop?: number;
  marginBottom?: number;
}

export function printBoxedLines(
  lines: readonly string[],
  options: SummaryBoxOptions = {},
): void {
  const boxenOptions: BoxenOptions = {
    padding: options.padding ?? 1,
    margin: { top: options.marginTop ?? 1, bottom: options.marginBottom ?? 1, left: 0, right: 0 },
    borderStyle: 'round',
    borderColor: TEAL,
    ...(options.title === undefined ? {} : { title: palette.accent(options.title), titleAlignment: 'left' as const }),
  };
  writeLine(boxen(lines.join('\n'), boxenOptions));
}

// ── Clipboard (pure utility) ────────────────────────────────────────────────

export function copyTextToClipboard(text: string): boolean {
  const commands: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['pbcopy', []],
    ['xclip', ['-selection', 'clipboard']],
    ['xsel', ['--clipboard', '--input']],
  ];

  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      input: text,
      encoding: 'utf8',
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    if (result.error !== undefined) continue;
    if (result.status === 0) return true;
  }

  return false;
}

// ── Zed manual setup (uses UI helpers) ──────────────────────────────────────

interface ManualBootstrapSetupOptions {
  harnessName: string;
  introLine: string;
  copyBootstrap: () => boolean | Promise<boolean>;
  waitForCopyPrompt: () => Promise<unknown>;
  waitForContinue: () => Promise<unknown>;
  steps: readonly string[];
}

export async function runManualBootstrapSetup(
  options: ManualBootstrapSetupOptions,
): Promise<void> {
  const {
    harnessName,
    introLine,
    copyBootstrap,
    waitForCopyPrompt,
    waitForContinue,
    steps,
  } = options;

  subheading(`${harnessName} MCP config is written automatically.`);
  note(introLine);
  writeLine();
  await waitForCopyPrompt();
  const copied = await copyBootstrap();
  if (copied) {
    success('Bootstrap instructions copied to clipboard.');
  } else {
    warn('Could not copy to clipboard automatically. Paste manually from templates/engram-bootstrap.tmpl.md.');
  }
  writeLine();
  subheading(`${harnessName} UI steps:`);
  writeLines(steps);
  writeLine();
  await waitForContinue();
  info(`Then run: ${palette.bold('"load your engram"')}.`);
}

export async function runManualZedSetup(options: {
  copyBootstrap: () => boolean | Promise<boolean>;
  waitForCopyPrompt: () => Promise<unknown>;
  waitForContinue: () => Promise<unknown>;
}): Promise<void> {
  const { copyBootstrap, waitForCopyPrompt, waitForContinue } = options;

  await runManualBootstrapSetup({
    harnessName: 'Zed',
    introLine: 'The bootstrap instructions still need to be pasted in Zed UI.',
    copyBootstrap,
    waitForCopyPrompt,
    waitForContinue,
    steps: [
      `  ${palette.accent('1.')} Open Zed and make sure the ${palette.bold('Agent Panel')} is visible.`,
      `  ${palette.accent('2.')} Click the menu button in the top right corner of the Agent Panel and select ${palette.bold('Rules')}.`,
      `  ${palette.accent('3.')} Click the ${palette.bold('+')} button to add a new Rule.`,
      `  ${palette.accent('4.')} Paste the bootstrap instructions from your clipboard into the Rule content.`,
      `  ${palette.accent('5.')} Name the Rule ${palette.bold('Engram')} and click the ${palette.bold('Add to Default Rules')} button to the right of the Rule name.`,
      `  ${palette.accent('6.')} Restart Zed.`,
    ],
  });
}

export async function runManualCursorSetup(options: {
  copyBootstrap: () => boolean | Promise<boolean>;
  waitForCopyPrompt: () => Promise<unknown>;
  waitForContinue: () => Promise<unknown>;
}): Promise<void> {
  const { copyBootstrap, waitForCopyPrompt, waitForContinue } = options;

  await runManualBootstrapSetup({
    harnessName: 'Cursor',
    introLine: 'Cursor requires a manual User Rule for bootstrap instructions.',
    copyBootstrap,
    waitForCopyPrompt,
    waitForContinue,
    steps: [
      `  ${palette.accent('1.')} Open Cursor and go to ${palette.bold('Settings > Cursor Settings > Rules, Skills, Subagents')}.`,
      `  ${palette.accent('2.')} Click ${palette.bold('+ New')} next to the ${palette.bold('Rules')} section's heading.`,
      `  ${palette.accent('3.')} Choose ${palette.bold('User Rule')} from the dropdown.`,
      `  ${palette.accent('4.')} Paste the bootstrap instructions from your clipboard into the Rule content.`,
      `  ${palette.accent('5.')} Click ${palette.bold('Done')} to save the rule.`,
      `  ${palette.accent('6.')} Restart Cursor.`,
    ],
  });
}

// ── Final init summary ──────────────────────────────────────────────────────

export function printInitSummary(answers: InitAnswers, repoContext: boolean): void {
  const soulPath = path.join(answers.vaultPath, answers.engramRoot, 'memory', 'soul.md');
  const pathLines = [
    `${palette.muted('Vault        ')} ${answers.vaultPath}`,
    `${palette.muted('Engram root  ')} ${answers.engramRoot}`,
    `${palette.muted('Soul         ')} ${soulPath}`,
  ];
  if (answers.cliBinDir !== null) {
    pathLines.push(`${palette.muted('CLI launcher ')} ${path.join(answers.cliBinDir, 'engram')}`);
  }

  const nextSteps = buildNextSteps(answers, repoContext);

  writeLine();
  writeLine(`${logSymbols.success} ${palette.brand(palette.bold('Init complete.'))} ${palette.muted('Your Engram is configured and ready.')}`);

  printBoxedLines(pathLines, { title: 'Paths' });
  printBoxedLines(nextSteps, { title: 'Next Steps' });
}

function buildNextSteps(answers: InitAnswers, repoContext: boolean): string[] {
  const steps: string[] = [];
  let stepNumber = 1;

  steps.push(`${palette.accent(`${String(stepNumber)}.`)} Review the generated Soul document and make it yours.`);
  stepNumber += 1;

  if (answers.installObsidianPlugin) {
    steps.push(`${palette.accent(`${String(stepNumber)}.`)} Open the vault in Obsidian and enable the Engram plugin if you haven't already.`);
  } else if (repoContext && answers.runSetup) {
    steps.push(`${palette.accent(`${String(stepNumber)}.`)} Plugin install was skipped. Rerun init later if you want it in this vault.`);
  } else if (repoContext) {
    steps.push(`${palette.accent(`${String(stepNumber)}.`)} Run the repo setup later to scaffold the dev vault and plugin wiring.`);
  } else {
    steps.push(`${palette.accent(`${String(stepNumber)}.`)} If you want shell-level access to Engram env vars later, rerun init and enable shell profile exports.`);
  }
  stepNumber += 1;

  if (answers.harnesses.claudeDesktop) {
    steps.push(`${palette.accent(`${String(stepNumber)}.`)} Restart Claude Desktop to load the updated MCP configuration.`);
    stepNumber += 1;
  }

  if (answers.harnesses.cursor) {
    steps.push(`${palette.accent(`${String(stepNumber)}.`)} In Cursor, verify your Engram User Rule is saved (Settings > Cursor Settings > Rules, Skills, Subagents).`);
    stepNumber += 1;
  }

  if (answers.harnesses.zed) {
    steps.push(`${palette.accent(`${String(stepNumber)}.`)} In Zed, confirm the Engram rule is added to default Agent Rules.`);
    stepNumber += 1;
  }

  if (answers.harnesses.claudeCode && answers.claudeCodeScope === 'user') {
    steps.push(`${palette.accent(`${String(stepNumber)}.`)} For Claude Code user scope, verify ~/.claude/CLAUDE.md contains the Engram bootstrap block.`);
    stepNumber += 1;
  }

  steps.push(`${palette.accent(`${String(stepNumber)}.`)} Start a session in a configured harness and use ${palette.bold('"load your engram"')} if bootstrap does not fire on greeting.`);
  return steps;
}
