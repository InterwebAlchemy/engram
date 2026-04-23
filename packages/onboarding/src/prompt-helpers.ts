import type * as readline from 'node:readline/promises';

import { isChoice } from './utils';

export async function ask(
  rl: readline.Interface,
  label: string,
  defaultValue = '',
): Promise<string> {
  const suffix = defaultValue.length > 0 ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${label}${suffix}: `)).trim();
  return answer.length > 0 ? answer : defaultValue;
}

export async function askRequired(
  rl: readline.Interface,
  label: string,
  defaultValue = '',
): Promise<string> {
  const answer = await ask(rl, label, defaultValue);
  return answer.trim().length > 0 ? answer.trim() : await askRequired(rl, label, defaultValue);
}

export async function askYesNo(
  rl: readline.Interface,
  label: string,
  defaultValue: boolean,
): Promise<boolean> {
  const suffix = defaultValue ? ' [Y/n]' : ' [y/N]';
  const answer = (await rl.question(`${label}${suffix}: `)).trim().toLowerCase();
  if (answer.length === 0) return defaultValue;
  return answer === 'y' || answer === 'yes';
}

export async function askChoice<T extends string>(
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
