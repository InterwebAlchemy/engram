import * as path from 'node:path';
import { env } from 'node:process';

const BACKSLASH_PATTERN = /\\/gu;
const WRAPPED_QUOTES_PATTERN = /^['"]|['"]$/gu;
const ESCAPE_REG_EXP_PATTERN = /[.*+?^${}()|[\]\\]/gu;
const ENV_KEY_PATTERN = /^[A-Z0-9_]+$/u;
const DEFAULT_ENGRAM_ROOT = 'engram';
const SECTION_BODY_PATTERN = '[\\s\\S]*?';

export function isEnvKey(value: string): boolean {
  return ENV_KEY_PATTERN.test(value);
}

export function replaceSection(markdown: string, heading: string, body: string): string {
  const pattern = new RegExp(
    `(?<prefix>## ${escapeRegExp(heading)}\\n\\n)(?<body>${SECTION_BODY_PATTERN})(?=\\n## |$)`,
    'u',
  );
  return markdown.replace(pattern, `$<prefix>${body.trim()}\n\n`);
}

export function quoteForShell(value: string): string {
  if (value.length === 0) return '""';
  if (/^[-A-Za-z0-9_./:]+$/u.test(value)) return value;
  return `"${value
    .replace(BACKSLASH_PATTERN, '\\\\')
    .replace(/"/gu, '\\"')
    .replace(/\$/gu, '\\$')
    .replace(/`/gu, '\\`')}"`;
}

export function stripQuotes(value: string): string {
  return value.replace(WRAPPED_QUOTES_PATTERN, '');
}

export function buildGitIdentity(name: string, email: string): string {
  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  if (trimmedName.length === 0 || trimmedEmail.length === 0) return '';
  return `${trimmedName} <${trimmedEmail}>`;
}

export function parseGitIdentity(value: string): { name: string; email: string } {
  const openBracketIndex = value.indexOf('<');
  const closeBracketIndex = value.lastIndexOf('>');
  if (openBracketIndex === -1 || closeBracketIndex === -1 || closeBracketIndex <= openBracketIndex) {
    return { name: '', email: '' };
  }

  const name = value.slice(0, openBracketIndex).trim();
  const email = value.slice(openBracketIndex + 1, closeBracketIndex).trim();
  if (name.length === 0 || email.length === 0) {
    return { name: '', email: '' };
  }
  return { name, email };
}

export function normalizeEngramRoot(value: string): string {
  const normalized = value.replace(BACKSLASH_PATTERN, '/').replace(/^\/+|\/+$/gu, '');
  return normalized.length > 0 ? normalized : DEFAULT_ENGRAM_ROOT;
}

export function expandHome(value: string): string {
  return value.startsWith('~')
    ? path.join(env.HOME ?? '', value.slice(1))
    : value;
}

export function isChoice<T extends string>(options: readonly T[], value: string): value is T {
  return options.some((option) => option === value);
}

export function escapeRegExp(value: string): string {
  return value.replace(ESCAPE_REG_EXP_PATTERN, '\\$&');
}
