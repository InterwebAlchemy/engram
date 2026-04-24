import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';
import type { Dirent } from 'node:fs';
import inquirer from 'inquirer';
import {
  cwd,
  env,
  stdin as input,
  stdout as output,
} from 'node:process';

import { expandHome, isChoice } from './utils.js';
import { writeLine } from './ui.js';

type InquirerPrompt = typeof inquirer;
type PathPromptKind = 'any' | 'directory' | 'file';

const PATH_PROMPT_PAGE_SIZE = 12;
const TRAILING_PATH_SEPARATOR_PATTERN = /[\\/]$/u;

export interface PromptSession {
  inquirer: InquirerPrompt | null;
  rl: readline.Interface | null;
}

export interface MultiChoiceOption<T extends string> {
  value: T;
  label: string;
  description?: string;
}

export interface PathPromptOptions {
  kind?: PathPromptKind;
}

interface PathChoice {
  value: string;
  name: string;
  description: string;
}

export function createPromptSession(): PromptSession {
  if (input.isTTY && output.isTTY) {
    return { inquirer, rl: null };
  }

  return {
    inquirer: null,
    rl: readline.createInterface({ input, output }),
  };
}

export function closePromptSession(prompt: PromptSession): void {
  prompt.rl?.close();
}

export async function ask(
  prompt: PromptSession,
  label: string,
  defaultValue = '',
): Promise<string> {
  if (prompt.inquirer !== null) {
    const answer = await prompt.inquirer.prompt<{ value: string }>([
      {
        type: 'input',
        name: 'value',
        message: label,
        default: defaultValue,
      },
    ]);
    writeLine();
    const value = answer.value.trim();
    return value.length > 0 ? value : defaultValue;
  }

  if (prompt.rl === null) return defaultValue;
  const suffix = defaultValue.length > 0 ? ` [${defaultValue}]` : '';
  const answer = (await prompt.rl.question(`${label}${suffix}: `)).trim();
  return answer.length > 0 ? answer : defaultValue;
}

export async function askRequired(
  prompt: PromptSession,
  label: string,
  defaultValue = '',
): Promise<string> {
  if (prompt.inquirer !== null) {
    const answer = await prompt.inquirer.prompt<{ value: string }>([
      {
        type: 'input',
        name: 'value',
        message: label,
        default: defaultValue,
        validate: (value: string) => value.trim().length > 0 || 'A value is required.',
      },
    ]);
    writeLine();
    return answer.value.trim();
  }

  const answer = await ask(prompt, label, defaultValue);
  return answer.trim().length > 0 ? answer.trim() : await askRequired(prompt, label, defaultValue);
}

export async function askPathRequired(
  prompt: PromptSession,
  label: string,
  defaultValue = '',
  options: PathPromptOptions = {},
): Promise<string> {
  const kind = options.kind ?? 'any';
  if (prompt.inquirer !== null) {
    const answer = await prompt.inquirer.prompt<{ value: string }>([
      {
        type: 'search',
        name: 'value',
        message: `${label} (Tab to autocomplete)`,
        pageSize: PATH_PROMPT_PAGE_SIZE,
        source: async (term: string | undefined) => {
          const normalizedTerm = normalizePromptInput(term);
          const resolvedValue = normalizedTerm.length > 0 ? normalizedTerm : defaultValue.trim();
          const choices = await listPathChoices(resolvedValue, kind);
          const directChoice = resolvedValue.length === 0
            ? []
            : [{
                value: resolvedValue,
                name: normalizedTerm.length === 0 ? `Use default: ${resolvedValue}` : `Use: ${resolvedValue}`,
                description: 'Use this exact path.',
              }];
          return dedupePathChoices([...directChoice, ...choices]);
        },
        validate: (value: string) => value.trim().length > 0 || 'A value is required.',
      },
    ]);
    writeLine();
    return answer.value.trim();
  }

  return await askRequired(prompt, label, defaultValue);
}

export async function askSubdirOf(
  prompt: PromptSession,
  label: string,
  baseDir: string,
  defaultValue = '',
): Promise<string> {
  if (prompt.inquirer !== null) {
    const answer = await prompt.inquirer.prompt<{ value: string }>([
      {
        type: 'search',
        name: 'value',
        message: `${label} (Tab to browse existing folders)`,
        pageSize: PATH_PROMPT_PAGE_SIZE,
        source: async (term: string | undefined) => {
          const typed = normalizePromptInput(term);
          const entries = await readDirectoryEntries(baseDir);
          const dirs = entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .filter((entry) => typed.length === 0 || entry.name.toLowerCase().startsWith(typed.toLowerCase()))
            .sort(compareDirectoryEntries)
            .slice(0, PATH_PROMPT_PAGE_SIZE)
            .map((entry) => ({
              value: entry.name,
              name: entry.name,
              description: path.join(baseDir, entry.name),
            }));

          const current = typed.length > 0 ? typed : defaultValue;
          const topChoice: PathChoice[] = current.length > 0
            ? [{
                value: current,
                name: typed.length > 0 ? `Create: ${current}` : `Use default: ${current}`,
                description: typed.length > 0 ? 'Create a new folder with this name.' : 'Use this folder name.',
              }]
            : [];

          return dedupePathChoices([...topChoice, ...dirs]);
        },
        validate: (value: string) => value.trim().length > 0 || 'A value is required.',
      },
    ]);
    writeLine();
    return answer.value.trim();
  }

  return await askRequired(prompt, label, defaultValue);
}

export async function askYesNo(
  prompt: PromptSession,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  if (prompt.inquirer !== null) {
    const answer = await prompt.inquirer.prompt<{ value: boolean }>([
      {
        type: 'confirm',
        name: 'value',
        message: label,
        default: defaultValue,
      },
    ]);
    writeLine();
    return answer.value;
  }

  if (prompt.rl === null) return defaultValue;
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
  const answer = (await prompt.rl.question(`${label}${suffix}: `)).trim().toLowerCase();
  if (answer.length === 0) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

export async function askChoice<T extends string>(
  prompt: PromptSession,
  label: string,
  options: readonly T[],
  defaultValue: T,
): Promise<T> {
  if (prompt.inquirer !== null) {
    const answer = await prompt.inquirer.prompt<{ value: T }>([
      {
        type: 'list',
        name: 'value',
        message: label,
        choices: options.map((option) => ({ value: option, name: option })),
        default: defaultValue,
      },
    ]);
    writeLine();
    return answer.value;
  }

  if (prompt.rl === null) return defaultValue;
  const defaultSuffix = defaultValue.length > 0 ? ` (${defaultValue})` : '';
  const answer = (await prompt.rl.question(`${label} [${options.join('/')}]${defaultSuffix}: `)).trim().toLowerCase();
  if (answer.length === 0) return defaultValue;
  return isChoice(options, answer) ? answer : await askChoice(prompt, label, options, defaultValue);
}

export async function askMultiChoice<T extends string>(
  prompt: PromptSession,
  label: string,
  options: ReadonlyArray<MultiChoiceOption<T>>,
  defaultValues: readonly T[],
): Promise<T[]> {
  if (prompt.inquirer !== null) {
    const selected = await prompt.inquirer.prompt<{ values: T[] }>([
      {
        type: 'checkbox',
        name: 'values',
        message: label,
        choices: options.map((option) => ({
          value: option.value,
          name: option.label,
          checked: defaultValues.includes(option.value),
        })),
      },
    ]);
    writeLine();
    return selected.values;
  }

  return await askMultiChoiceFallback(prompt, options, defaultValues);
}

async function askMultiChoiceFallback<T extends string>(
  prompt: PromptSession,
  options: ReadonlyArray<MultiChoiceOption<T>>,
  defaultValues: readonly T[],
): Promise<T[]> {
  return await options.reduce<Promise<T[]>>(async (selectedPromise, option) => {
    const selected = await selectedPromise;
    const checked = await askYesNo(
      prompt,
      `Configure ${option.label}?`,
      defaultValues.includes(option.value),
    );
    return checked ? [...selected, option.value] : selected;
  }, Promise.resolve([]));
}

function normalizePromptInput(value: string | undefined): string {
  if (value === undefined) return '';
  return value.trim();
}

function hasTrailingPathSeparator(value: string): boolean {
  return TRAILING_PATH_SEPARATOR_PATTERN.test(value);
}

function toAbsolutePath(value: string): string {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(cwd(), value);
}

function collapseHomePath(value: string): string {
  const { HOME: home } = env;
  if (home === undefined || home.length === 0) return value;
  const normalizedHome = path.resolve(home);
  const normalizedValue = path.resolve(value);
  if (normalizedValue === normalizedHome) return '~';
  const prefix = `${normalizedHome}${path.sep}`;
  return normalizedValue.startsWith(prefix)
    ? `~${normalizedValue.slice(normalizedHome.length)}`
    : value;
}

async function readDirectoryEntries(
  dirPath: string,
): Promise<readonly Dirent[]> {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

function compareDirectoryEntries(
  left: Dirent,
  right: Dirent,
): number {
  if (left.isDirectory() && !right.isDirectory()) return -1;
  if (!left.isDirectory() && right.isDirectory()) return 1;
  return left.name.localeCompare(right.name);
}

function formatChoicePath(
  absolutePath: string,
  isDirectory: boolean,
): { value: string; label: string; description: string } {
  const collapsed = collapseHomePath(absolutePath);
  const value = isDirectory ? `${collapsed}${path.sep}` : collapsed;
  const label = isDirectory ? `${path.basename(absolutePath)}${path.sep}` : path.basename(absolutePath);
  return {
    value,
    label,
    description: collapsed,
  };
}

async function listPathChoices(
  inputValue: string,
  kind: PathPromptKind,
): Promise<PathChoice[]> {
  const expandedInput = expandHome(inputValue);
  if (expandedInput.length === 0) return [];

  const absoluteInput = toAbsolutePath(expandedInput);
  const treatInputAsDirectory = hasTrailingPathSeparator(inputValue) || hasTrailingPathSeparator(expandedInput);
  const searchDirectory = treatInputAsDirectory ? absoluteInput : path.dirname(absoluteInput);
  const prefix = treatInputAsDirectory ? '' : path.basename(absoluteInput).toLowerCase();
  const entries = await readDirectoryEntries(searchDirectory);
  const sortedEntries = [...entries].sort(compareDirectoryEntries);

  return sortedEntries
    .filter((entry) => entry.name.toLowerCase().startsWith(prefix))
    .filter((entry) => kind !== 'directory' || entry.isDirectory())
    .slice(0, PATH_PROMPT_PAGE_SIZE)
    .map((entry) => {
      const absoluteEntryPath = path.join(searchDirectory, entry.name);
      const formatted = formatChoicePath(absoluteEntryPath, entry.isDirectory());
      return {
        value: formatted.value,
        name: formatted.label,
        description: formatted.description,
      };
    });
}

function dedupePathChoices(
  choices: readonly PathChoice[],
): PathChoice[] {
  const seen = new Set<string>();
  return choices.filter((choice) => {
    if (seen.has(choice.value)) return false;
    seen.add(choice.value);
    return true;
  });
}
