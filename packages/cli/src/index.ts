#!/usr/bin/env node
/* eslint-disable max-lines -- agent-facing CLI intentionally keeps command routing in one module for now. */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  argv,
  env,
  exit,
  stderr,
  stdin,
  stdout,
} from 'node:process';
import {
  MemoryManager,
  NodeAdapter,
  defaultMemoryConfig,
  executeToolCall,
  extractText,
  type ToolArgs,
  type ToolResponse,
} from '@interwebalchemy/engram-core';

const CLI_ARG_START_INDEX = 2;
const CONFIG_PATH_SEGMENTS = ['.engram', 'config.json'] as const;
const FLAG_PREFIX = '--';
const STDIN_VALUE = '-';
const FILE_VALUE_PREFIX = '-@';
const CHECKPOINT_SCRATCH_PREFIX = 'Scratch: append at milestones.';
const CHECKPOINT_SESSION_PREFIX = 'Session ID:';
const HOME_PREFIX_LENGTH = 2;
const JSON_OUTPUT_INDENT = 2;

type SupportedMode = 'integrated' | 'standalone';

interface ParsedGlobalArgs {
  commandTokens: string[];
  json: boolean;
  help: boolean;
  runtimeOverrides: RuntimeOverrides;
}

interface RuntimeOverrides {
  vault?: string;
  engramRoot?: string;
  mode?: SupportedMode;
  readPaths?: string[];
}

interface ResolvedRuntimeConfig {
  vaultPath: string;
  engramRoot?: string;
  mode: SupportedMode;
  readPaths: string[];
}

interface ParsedCommandTokens {
  options: Map<string, string | true>;
  positionals: string[];
}

interface ToolInvocation {
  name: string;
  args: ToolArgs;
}

interface PersistedConfigShape {
  vaultPath?: unknown;
  engramRoot?: unknown;
}

let stdinCache: Promise<string> | null = null;

function writeOut(message = ''): void {
  stdout.write(`${message}\n`);
}

function writeErr(message: string): void {
  stderr.write(`${message}\n`);
}

function parseGlobalArgs(tokens: string[]): ParsedGlobalArgs {
  const commandTokens: string[] = [];
  const runtimeOverrides: RuntimeOverrides = {};
  let json = false;
  let help = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const { [index]: token } = tokens;

    if (token === '--json') {
      json = true;
      continue;
    }

    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }

    const { [index + 1]: nextToken } = tokens;
    const matched = matchGlobalFlag(token, nextToken);
    if (matched === null) {
      commandTokens.push(token);
      continue;
    }

    const {
      key,
      usedNext,
      value,
    } = matched;
    index += usedNext ? 1 : 0;
    switch (key) {
      case 'vault':
        runtimeOverrides.vault = value;
        break;
      case 'engram-root':
        runtimeOverrides.engramRoot = value;
        break;
      case 'mode':
        runtimeOverrides.mode = parseMode(value);
        break;
      case 'read-paths':
        runtimeOverrides.readPaths = splitCsv(value) ?? [];
        break;
    }
  }

  return { commandTokens, json, help, runtimeOverrides };
}

function matchGlobalFlag(
  token: string,
  nextToken: string | undefined,
): {
    key: 'vault' | 'engram-root' | 'mode' | 'read-paths';
    value: string;
    usedNext: boolean;
  } | null {
  if (token.startsWith('--vault=')) {
    return { key: 'vault', value: token.slice('--vault='.length), usedNext: false };
  }
  if (token === '--vault') {
    return { key: 'vault', value: requireNextValue('--vault', nextToken), usedNext: true };
  }

  if (token.startsWith('--engram-root=')) {
    return { key: 'engram-root', value: token.slice('--engram-root='.length), usedNext: false };
  }
  if (token === '--engram-root') {
    return { key: 'engram-root', value: requireNextValue('--engram-root', nextToken), usedNext: true };
  }

  if (token.startsWith('--mode=')) {
    return { key: 'mode', value: token.slice('--mode='.length), usedNext: false };
  }
  if (token === '--mode') {
    return { key: 'mode', value: requireNextValue('--mode', nextToken), usedNext: true };
  }

  if (token.startsWith('--read-paths=')) {
    return { key: 'read-paths', value: token.slice('--read-paths='.length), usedNext: false };
  }
  if (token === '--read-paths') {
    return { key: 'read-paths', value: requireNextValue('--read-paths', nextToken), usedNext: true };
  }

  return null;
}

function requireNextValue(flag: string, nextValue: string | undefined): string {
  if (typeof nextValue !== 'string' || nextValue.length === 0) {
    throw new Error(`${flag} requires a value.`);
  }
  return nextValue;
}

function parseMode(value: string): SupportedMode {
  return value === 'standalone' ? 'standalone' : 'integrated';
}

async function resolveRuntimeConfig(overrides: RuntimeOverrides): Promise<ResolvedRuntimeConfig> {
  const persisted = await readPersistedConfig();
  const vaultPath = resolveVaultPath(overrides, persisted);
  const engramRoot = resolveEngramRoot(overrides, persisted);

  return {
    vaultPath,
    engramRoot,
    mode: overrides.mode ?? parseMode(env.ENGRAM_MODE ?? 'integrated'),
    readPaths: overrides.readPaths ?? splitCsv(env.ENGRAM_READ_PATHS) ?? [],
  };
}

function maybeNonEmpty(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function expandHomePath(value: string): string {
  if (value === '~') {
    return os.homedir();
  }
  if (value.startsWith('~/')) {
    return path.join(os.homedir(), value.slice(HOME_PREFIX_LENGTH));
  }
  return value;
}

function resolveVaultPath(overrides: RuntimeOverrides, persisted: PersistedConfigShape): string {
  const resolved = expandHomePath(
    overrides.vault
    ?? maybeNonEmpty(env.ENGRAM_VAULT_PATH)
    ?? (typeof persisted.vaultPath === 'string' ? persisted.vaultPath : ''),
  );
  if (resolved.length > 0) {
    return resolved;
  }

  throw new Error('Vault path is not configured. Run `onboarding init` or pass `--vault <path>`.');
}

function resolveEngramRoot(
  overrides: RuntimeOverrides,
  persisted: PersistedConfigShape,
): string | undefined {
  return maybeNonEmpty(
    overrides.engramRoot
    ?? maybeNonEmpty(env.ENGRAM_ROOT)
    ?? (typeof persisted.engramRoot === 'string' ? persisted.engramRoot : undefined),
  );
}

async function readPersistedConfig(): Promise<PersistedConfigShape> {
  const configPath = path.join(os.homedir(), ...CONFIG_PATH_SEGMENTS);
  try {
    const raw = await fs.readFile(configPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      return parsed;
    }
    return {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCommandTokens(tokens: string[]): ParsedCommandTokens {
  const options = new Map<string, string | true>();
  const positionals: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const { [index]: token } = tokens;

    if (!token.startsWith(FLAG_PREFIX)) {
      positionals.push(token);
      continue;
    }

    const equalIndex = token.indexOf('=');
    if (equalIndex > 0) {
      const optionName = token.slice(FLAG_PREFIX.length, equalIndex);
      const optionValue = token.slice(equalIndex + 1);
      options.set(optionName, optionValue);
      continue;
    }

    const optionName = token.slice(FLAG_PREFIX.length);
    const { [index + 1]: nextValue } = tokens;
    if (typeof nextValue !== 'string' || nextValue.startsWith(FLAG_PREFIX)) {
      options.set(optionName, true);
      continue;
    }

    options.set(optionName, nextValue);
    index += 1;
  }

  return { options, positionals };
}

function ensureKnownOptions(parsed: ParsedCommandTokens, allowed: readonly string[]): void {
  for (const key of parsed.options.keys()) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown option: --${key}`);
    }
  }
}

function ensureNoPositionals(parsed: ParsedCommandTokens): void {
  if (parsed.positionals.length > 0) {
    throw new Error(`Unexpected positional arguments: ${parsed.positionals.join(' ')}`);
  }
}

function readOptionString(parsed: ParsedCommandTokens, key: string): string | undefined {
  const raw = parsed.options.get(key);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === true) {
    throw new Error(`--${key} requires a value.`);
  }
  return raw;
}

function requireOptionString(parsed: ParsedCommandTokens, key: string): string {
  const value = readOptionString(parsed, key);
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  throw new Error(`Missing required option: --${key}`);
}

function readOptionNumber(parsed: ParsedCommandTokens, key: string): number | undefined {
  const value = readOptionString(parsed, key);
  if (value === undefined) {
    return undefined;
  }
  const parsedNumber = Number(value);
  if (!Number.isFinite(parsedNumber)) {
    throw new Error(`--${key} must be a number.`);
  }
  return parsedNumber;
}

function readOptionBoolean(parsed: ParsedCommandTokens, key: string): boolean | undefined {
  const raw = parsed.options.get(key);
  if (raw === undefined) {
    return undefined;
  }
  if (raw === true) {
    return true;
  }

  const normalized = raw.toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) {
    return true;
  }
  if (['false', '0', 'no', 'n'].includes(normalized)) {
    return false;
  }
  throw new Error(`--${key} must be true or false.`);
}

function splitCsv(value: string | undefined): string[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const values = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return values.length > 0 ? values : undefined;
}

async function readTextArg(value: string, optionName: string): Promise<string> {
  if (value !== STDIN_VALUE) {
    return value;
  }

  const stdinText = await readStdinText();
  if (stdinText.trim().length === 0) {
    throw new Error(`No stdin content provided for --${optionName}.`);
  }
  return stdinText;
}

async function readStdinText(): Promise<string> {
  stdinCache ??= collectStdin();
  return await stdinCache;
}

async function collectStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin as AsyncIterable<string | Buffer>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error: unknown) {
    throw new Error(`${label} must be valid JSON.`, {
      cause: error,
    });
  }
}

async function parseMessagesArg(value: string): Promise<unknown> {
  if (value === STDIN_VALUE) {
    return parseJson(await readStdinText(), '--messages');
  }

  if (value.startsWith(FILE_VALUE_PREFIX)) {
    const filePath = expandHomePath(value.slice(FILE_VALUE_PREFIX.length));
    const raw = await fs.readFile(filePath, 'utf8');
    return parseJson(raw, '--messages');
  }

  return parseJson(value, '--messages');
}

async function buildInvocation(tokens: string[]): Promise<ToolInvocation> {
  const [toolGroup, action, ...rest] = tokens;

  switch (toolGroup) {
    case 'soul':
      return await buildSoulInvocation(action, rest);
    case 'thread':
      return await buildThreadInvocation(action, rest);
    case 'context':
      return await buildContextInvocation(action, rest);
    case 'scratch':
      return await buildScratchInvocation(action, rest);
    case 'memory':
      return await buildMemoryInvocation(action, rest);
    case 'inbox':
      return await buildInboxInvocation(action, rest);
    case 'note':
      return await buildNoteInvocation(action, rest);
    case 'skill':
      return await buildSkillInvocation(action, rest);
    case 'conversation':
      return await buildConversationInvocation(action, rest);
    case 'tool':
      return await buildRawToolInvocation(action, rest);
    default:
      throw new Error(`Unknown command: ${toolGroup}`);
  }
}

async function buildSoulInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  const parsed = parseCommandTokens(tokens);

  if (action === 'get') {
    ensureKnownOptions(parsed, []);
    ensureNoPositionals(parsed);
    return { name: 'soul', args: { action: 'get' } };
  }

  if (action === 'set') {
    ensureKnownOptions(parsed, ['content']);
    ensureNoPositionals(parsed);
    const content = await readTextArg(requireOptionString(parsed, 'content'), 'content');
    return { name: 'soul', args: { action: 'set', content } };
  }

  throw new Error('Usage: engram soul get | set --content <text|->');
}

async function buildThreadInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  const parsed = parseCommandTokens(tokens);

  switch (action) {
    case 'resolve': {
      ensureKnownOptions(parsed, ['cwd', 'git-remote', 'auto-create']);
      ensureNoPositionals(parsed);
      return {
        name: 'thread',
        args: {
          action: 'resolve',
          cwd: readOptionString(parsed, 'cwd'),
          git_remote: readOptionString(parsed, 'git-remote'),
          auto_create: readOptionBoolean(parsed, 'auto-create'),
        },
      };
    }
    case 'get': {
      ensureKnownOptions(parsed, ['id']);
      ensureNoPositionals(parsed);
      return { name: 'thread', args: { action: 'get', thread_id: requireOptionString(parsed, 'id') } };
    }
    case 'list': {
      ensureKnownOptions(parsed, []);
      ensureNoPositionals(parsed);
      return { name: 'thread', args: { action: 'list' } };
    }
    case 'set': {
      ensureKnownOptions(parsed, ['id', 'content', 'name', 'description', 'status', 'goals', 'paths', 'related-threads', 'tags']);
      ensureNoPositionals(parsed);
      return {
        name: 'thread',
        args: {
          action: 'set',
          thread_id: requireOptionString(parsed, 'id'),
          content: await readTextArg(requireOptionString(parsed, 'content'), 'content'),
          name: readOptionString(parsed, 'name'),
          description: readOptionString(parsed, 'description'),
          status: readOptionString(parsed, 'status'),
          goals: splitCsv(readOptionString(parsed, 'goals')),
          paths: splitCsv(readOptionString(parsed, 'paths')),
          related_threads: splitCsv(readOptionString(parsed, 'related-threads')),
          tags: splitCsv(readOptionString(parsed, 'tags')),
        },
      };
    }
    case 'update': {
      ensureKnownOptions(parsed, ['id', 'content', 'name', 'description', 'status', 'goals', 'paths', 'related-threads', 'tags']);
      ensureNoPositionals(parsed);
      const content = readOptionString(parsed, 'content');
      return {
        name: 'thread',
        args: {
          action: 'update',
          thread_id: requireOptionString(parsed, 'id'),
          content: typeof content === 'string' ? await readTextArg(content, 'content') : undefined,
          name: readOptionString(parsed, 'name'),
          description: readOptionString(parsed, 'description'),
          status: readOptionString(parsed, 'status'),
          goals: splitCsv(readOptionString(parsed, 'goals')),
          paths: splitCsv(readOptionString(parsed, 'paths')),
          related_threads: splitCsv(readOptionString(parsed, 'related-threads')),
          tags: splitCsv(readOptionString(parsed, 'tags')),
        },
      };
    }
    case 'merge': {
      ensureKnownOptions(parsed, ['source', 'target']);
      ensureNoPositionals(parsed);
      return {
        name: 'thread',
        args: {
          action: 'merge',
          source_thread_id: requireOptionString(parsed, 'source'),
          target_thread_id: requireOptionString(parsed, 'target'),
        },
      };
    }
    case 'todo-add': {
      ensureKnownOptions(parsed, ['id', 'item', 'prepend']);
      ensureNoPositionals(parsed);
      return {
        name: 'thread',
        args: {
          action: 'todo_add',
          thread_id: requireOptionString(parsed, 'id'),
          item: await readTextArg(requireOptionString(parsed, 'item'), 'item'),
          prepend: readOptionBoolean(parsed, 'prepend'),
        },
      };
    }
    case 'todo-complete': {
      ensureKnownOptions(parsed, ['id', 'item']);
      ensureNoPositionals(parsed);
      return {
        name: 'thread',
        args: {
          action: 'todo_complete',
          thread_id: requireOptionString(parsed, 'id'),
          item: await readTextArg(requireOptionString(parsed, 'item'), 'item'),
        },
      };
    }
    case 'todo-reopen': {
      ensureKnownOptions(parsed, ['id', 'item']);
      ensureNoPositionals(parsed);
      return {
        name: 'thread',
        args: {
          action: 'todo_reopen',
          thread_id: requireOptionString(parsed, 'id'),
          item: await readTextArg(requireOptionString(parsed, 'item'), 'item'),
        },
      };
    }
    case 'todo-remove': {
      ensureKnownOptions(parsed, ['id', 'item']);
      ensureNoPositionals(parsed);
      return {
        name: 'thread',
        args: {
          action: 'todo_remove',
          thread_id: requireOptionString(parsed, 'id'),
          item: await readTextArg(requireOptionString(parsed, 'item'), 'item'),
        },
      };
    }
    case 'todo-list': {
      ensureKnownOptions(parsed, ['id', 'include-completed']);
      ensureNoPositionals(parsed);
      return {
        name: 'thread',
        args: {
          action: 'todo_list',
          thread_id: requireOptionString(parsed, 'id'),
          include_completed: readOptionBoolean(parsed, 'include-completed'),
        },
      };
    }
    default:
      throw new Error('Usage: engram thread <resolve|get|list|set|update|merge|todo-add|todo-complete|todo-reopen|todo-remove|todo-list> ...');
  }
}

async function buildContextInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  if (action !== 'load') {
    throw new Error('Usage: engram context load --query <text> [--thread-id <id>] [--token-budget <n>]');
  }

  const parsed = parseCommandTokens(tokens);
  ensureKnownOptions(parsed, ['query', 'thread-id', 'token-budget']);
  ensureNoPositionals(parsed);

  return {
    name: 'context',
    args: {
      action: 'load',
      query: await readTextArg(requireOptionString(parsed, 'query'), 'query'),
      thread_id: readOptionString(parsed, 'thread-id'),
      token_budget: readOptionNumber(parsed, 'token-budget'),
    },
  };
}

async function buildScratchInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  const parsed = parseCommandTokens(tokens);

  switch (action) {
    case 'append': {
      ensureKnownOptions(parsed, ['content']);
      const positionalContent = parsed.positionals.length > 0
        ? parsed.positionals.join(' ')
        : undefined;
      const rawContent = positionalContent ?? requireOptionString(parsed, 'content');
      return {
        name: 'scratch',
        args: {
          action: 'append',
          content: await readTextArg(rawContent, 'content'),
        },
      };
    }
    case 'read': {
      ensureKnownOptions(parsed, ['bootstrap', 'limit', 'since', 'session-id', 'token-budget']);
      ensureNoPositionals(parsed);
      return {
        name: 'scratch',
        args: {
          action: 'read',
          bootstrap: readOptionBoolean(parsed, 'bootstrap'),
          limit: readOptionNumber(parsed, 'limit'),
          since: readOptionString(parsed, 'since'),
          session_id: readOptionString(parsed, 'session-id'),
          token_budget: readOptionNumber(parsed, 'token-budget'),
        },
      };
    }
    case 'compact': {
      ensureKnownOptions(parsed, ['session-id', 'content', 'threshold-hours']);
      ensureNoPositionals(parsed);
      return {
        name: 'scratch',
        args: {
          action: 'compact',
          session_id: requireOptionString(parsed, 'session-id'),
          compacted_content: await readTextArg(requireOptionString(parsed, 'content'), 'content'),
          threshold_hours: readOptionNumber(parsed, 'threshold-hours'),
        },
      };
    }
    case 'prune': {
      ensureKnownOptions(parsed, []);
      ensureNoPositionals(parsed);
      return { name: 'scratch', args: { action: 'prune' } };
    }
    case 'delete': {
      ensureKnownOptions(parsed, ['session-id', 'match-text', 'threshold-hours']);
      ensureNoPositionals(parsed);
      return {
        name: 'scratch',
        args: {
          action: 'delete',
          session_id: readOptionString(parsed, 'session-id'),
          match_text: readOptionString(parsed, 'match-text'),
          threshold_hours: readOptionNumber(parsed, 'threshold-hours'),
        },
      };
    }
    case 'clear': {
      ensureKnownOptions(parsed, []);
      ensureNoPositionals(parsed);
      return { name: 'scratch', args: { action: 'clear' } };
    }
    default:
      throw new Error('Usage: engram scratch <append|read|compact|prune|delete|clear> ...');
  }
}

async function buildMemoryInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  const parsed = parseCommandTokens(tokens);

  switch (action) {
    case 'store': {
      ensureKnownOptions(parsed, ['content', 'type', 'state', 'tags', 'summary', 'thread', 'confidence', 'bootstrap-state', 'agent', 'platform', 'session-id']);
      ensureNoPositionals(parsed);
      return {
        name: 'memory',
        args: {
          action: 'store',
          content: await readTextArg(requireOptionString(parsed, 'content'), 'content'),
          type: requireOptionString(parsed, 'type'),
          state: readOptionString(parsed, 'state'),
          tags: splitCsv(readOptionString(parsed, 'tags')),
          summary: readOptionString(parsed, 'summary'),
          thread: readOptionString(parsed, 'thread'),
          confidence: readOptionString(parsed, 'confidence'),
          bootstrap_state: readOptionString(parsed, 'bootstrap-state'),
          agent: readOptionString(parsed, 'agent'),
          platform: readOptionString(parsed, 'platform'),
          session_id: readOptionString(parsed, 'session-id'),
        },
      };
    }
    case 'search': {
      ensureKnownOptions(parsed, ['query', 'limit', 'state', 'type', 'tags', 'bootstrap-state', 'agent', 'platform', 'thread']);
      ensureNoPositionals(parsed);
      return {
        name: 'memory',
        args: {
          action: 'search',
          query: await readTextArg(requireOptionString(parsed, 'query'), 'query'),
          limit: readOptionNumber(parsed, 'limit'),
          state: readOptionString(parsed, 'state'),
          type: readOptionString(parsed, 'type'),
          tags: splitCsv(readOptionString(parsed, 'tags')),
          bootstrap_state: readOptionString(parsed, 'bootstrap-state'),
          agent: readOptionString(parsed, 'agent'),
          platform: readOptionString(parsed, 'platform'),
          thread: readOptionString(parsed, 'thread'),
        },
      };
    }
    case 'read': {
      ensureKnownOptions(parsed, ['path']);
      ensureNoPositionals(parsed);
      return { name: 'memory', args: { action: 'read', path: requireOptionString(parsed, 'path') } };
    }
    case 'list': {
      ensureKnownOptions(parsed, ['type', 'state', 'limit', 'bootstrap-state', 'agent', 'platform', 'thread']);
      ensureNoPositionals(parsed);
      return {
        name: 'memory',
        args: {
          action: 'list',
          type: readOptionString(parsed, 'type'),
          state: readOptionString(parsed, 'state'),
          limit: readOptionNumber(parsed, 'limit'),
          bootstrap_state: readOptionString(parsed, 'bootstrap-state'),
          agent: readOptionString(parsed, 'agent'),
          platform: readOptionString(parsed, 'platform'),
          thread: readOptionString(parsed, 'thread'),
        },
      };
    }
    case 'update': {
      ensureKnownOptions(parsed, ['path', 'content', 'type', 'state', 'tags', 'summary', 'thread', 'bootstrap-state', 'agent', 'platform', 'session-id']);
      ensureNoPositionals(parsed);
      const content = readOptionString(parsed, 'content');
      return {
        name: 'memory',
        args: {
          action: 'update',
          path: requireOptionString(parsed, 'path'),
          content: typeof content === 'string' ? await readTextArg(content, 'content') : undefined,
          type: readOptionString(parsed, 'type'),
          state: readOptionString(parsed, 'state'),
          tags: splitCsv(readOptionString(parsed, 'tags')),
          summary: readOptionString(parsed, 'summary'),
          thread: readOptionString(parsed, 'thread'),
          bootstrap_state: readOptionString(parsed, 'bootstrap-state'),
          agent: readOptionString(parsed, 'agent'),
          platform: readOptionString(parsed, 'platform'),
          session_id: readOptionString(parsed, 'session-id'),
        },
      };
    }
    case 'archive': {
      ensureKnownOptions(parsed, ['older-than-days']);
      ensureNoPositionals(parsed);
      return {
        name: 'memory',
        args: {
          action: 'archive',
          older_than_days: readOptionNumber(parsed, 'older-than-days'),
        },
      };
    }
    default:
      throw new Error('Usage: engram memory <store|search|read|list|update|archive> ...');
  }
}

async function buildInboxInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  const parsed = parseCommandTokens(tokens);

  switch (action) {
    case 'list': {
      ensureKnownOptions(parsed, ['thread-id']);
      ensureNoPositionals(parsed);
      return { name: 'inbox', args: { action: 'list', thread_id: readOptionString(parsed, 'thread-id') } };
    }
    case 'add': {
      ensureKnownOptions(parsed, ['content', 'thread-id', 'name']);
      ensureNoPositionals(parsed);
      return {
        name: 'inbox',
        args: {
          action: 'add',
          content: await readTextArg(requireOptionString(parsed, 'content'), 'content'),
          thread_id: readOptionString(parsed, 'thread-id'),
          name: readOptionString(parsed, 'name'),
        },
      };
    }
    case 'read': {
      ensureKnownOptions(parsed, ['path']);
      ensureNoPositionals(parsed);
      return { name: 'inbox', args: { action: 'read', path: requireOptionString(parsed, 'path') } };
    }
    case 'remove': {
      ensureKnownOptions(parsed, ['path']);
      ensureNoPositionals(parsed);
      return { name: 'inbox', args: { action: 'remove', path: requireOptionString(parsed, 'path') } };
    }
    default:
      throw new Error('Usage: engram inbox <list|add|read|remove> ...');
  }
}

async function buildNoteInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  const parsed = parseCommandTokens(tokens);

  switch (action) {
    case 'create': {
      ensureKnownOptions(parsed, ['path', 'content']);
      ensureNoPositionals(parsed);
      return {
        name: 'note',
        args: {
          action: 'create',
          path: requireOptionString(parsed, 'path'),
          content: await readTextArg(requireOptionString(parsed, 'content'), 'content'),
        },
      };
    }
    case 'read': {
      ensureKnownOptions(parsed, ['path']);
      ensureNoPositionals(parsed);
      return { name: 'note', args: { action: 'read', path: requireOptionString(parsed, 'path') } };
    }
    case 'update': {
      ensureKnownOptions(parsed, ['path', 'content', 'expected-current-content']);
      ensureNoPositionals(parsed);
      return {
        name: 'note',
        args: {
          action: 'update',
          path: requireOptionString(parsed, 'path'),
          content: await readTextArg(requireOptionString(parsed, 'content'), 'content'),
          expected_current_content: readOptionString(parsed, 'expected-current-content'),
        },
      };
    }
    case 'append': {
      ensureKnownOptions(parsed, ['path', 'content', 'separator', 'expected-current-content']);
      ensureNoPositionals(parsed);
      return {
        name: 'note',
        args: {
          action: 'append',
          path: requireOptionString(parsed, 'path'),
          content: await readTextArg(requireOptionString(parsed, 'content'), 'content'),
          separator: readOptionString(parsed, 'separator'),
          expected_current_content: readOptionString(parsed, 'expected-current-content'),
        },
      };
    }
    case 'list': {
      ensureKnownOptions(parsed, ['prefix', 'limit']);
      ensureNoPositionals(parsed);
      return {
        name: 'note',
        args: {
          action: 'list',
          prefix: readOptionString(parsed, 'prefix'),
          limit: readOptionNumber(parsed, 'limit'),
        },
      };
    }
    case 'search': {
      ensureKnownOptions(parsed, ['query', 'limit']);
      ensureNoPositionals(parsed);
      return {
        name: 'note',
        args: {
          action: 'search',
          query: await readTextArg(requireOptionString(parsed, 'query'), 'query'),
          limit: readOptionNumber(parsed, 'limit'),
        },
      };
    }
    case 'delete': {
      ensureKnownOptions(parsed, ['path']);
      ensureNoPositionals(parsed);
      return { name: 'note', args: { action: 'delete', path: requireOptionString(parsed, 'path') } };
    }
    default:
      throw new Error('Usage: engram note <create|read|update|append|list|search|delete> ...');
  }
}

async function buildSkillInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  const parsed = parseCommandTokens(tokens);

  switch (action) {
    case 'list': {
      ensureKnownOptions(parsed, []);
      ensureNoPositionals(parsed);
      return { name: 'skill', args: { action: 'list' } };
    }
    case 'get': {
      ensureKnownOptions(parsed, ['slug']);
      ensureNoPositionals(parsed);
      return { name: 'skill', args: { action: 'get', slug: requireOptionString(parsed, 'slug') } };
    }
    case 'store': {
      ensureKnownOptions(parsed, ['slug', 'content', 'tags']);
      ensureNoPositionals(parsed);
      return {
        name: 'skill',
        args: {
          action: 'store',
          slug: requireOptionString(parsed, 'slug'),
          content: await readTextArg(requireOptionString(parsed, 'content'), 'content'),
          tags: splitCsv(readOptionString(parsed, 'tags')),
        },
      };
    }
    default:
      throw new Error('Usage: engram skill <list|get|store> ...');
  }
}

async function buildConversationInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  if (action !== 'save') {
    throw new Error('Usage: engram conversation save --messages <json|-@file|-> [--summary <text>] [--tags a,b]');
  }

  const parsed = parseCommandTokens(tokens);
  ensureKnownOptions(parsed, ['messages', 'summary', 'tags']);
  ensureNoPositionals(parsed);

  return {
    name: 'conversation',
    args: {
      action: 'save',
      messages: await parseMessagesArg(requireOptionString(parsed, 'messages')),
      summary: readOptionString(parsed, 'summary'),
      tags: splitCsv(readOptionString(parsed, 'tags')),
    },
  };
}

async function buildRawToolInvocation(action: string | undefined, tokens: string[]): Promise<ToolInvocation> {
  if (typeof action !== 'string' || action.length === 0) {
    throw new Error('Usage: engram tool <name> <json-args|->');
  }

  if (tokens.length === 0) {
    return { name: action, args: {} };
  }

  const rawArg = tokens.join(' ');
  const input = rawArg === STDIN_VALUE ? await readStdinText() : rawArg;
  const parsed = parseJson(input, 'tool args');
  if (!isRecord(parsed)) {
    throw new Error('tool args must be a JSON object.');
  }

  return { name: action, args: parsed };
}

function cleanToolText(text: string): string {
  const lines = text.replace(/\r\n/gu, '\n').split('\n');
  trimTrailingEmptyLines(lines);
  popIfLastLineMatchesPrefix(lines, CHECKPOINT_SCRATCH_PREFIX);
  popIfLastLineMatchesPrefix(lines, CHECKPOINT_SESSION_PREFIX);
  popIfLastLineEquals(lines, '---');
  trimTrailingEmptyLines(lines);

  return lines.join('\n');
}

function trimTrailingEmptyLines(lines: string[]): void {
  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop();
  }
}

function popIfLastLineMatchesPrefix(lines: string[], prefix: string): void {
  if (lines.length > 0 && lines[lines.length - 1].startsWith(prefix)) {
    lines.pop();
  }
}

function popIfLastLineEquals(lines: string[], expected: string): void {
  if (lines.length > 0 && lines[lines.length - 1].trim() === expected) {
    lines.pop();
  }
}

function formatStatusLine(text: string): string {
  const firstLine = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstLine ?? 'completed';
}

function reportSuccess(response: ToolResponse, json: boolean): void {
  if (json) {
    writeOut(JSON.stringify(response, null, JSON_OUTPUT_INDENT));
    return;
  }

  const { text } = extractText(response);
  const cleaned = cleanToolText(text);
  if (!cleaned.includes('\n')) {
    writeOut(`ok: ${formatStatusLine(cleaned)}`);
    return;
  }

  writeOut(`ok: ${formatStatusLine(cleaned)}`);
  writeOut();
  writeOut(cleaned);
}

function reportError(response: ToolResponse): void {
  const { text } = extractText(response);
  const cleaned = cleanToolText(text);
  const reason = formatStatusLine(cleaned).replace(/^Error:\s*/u, '');
  writeErr(`err: ${reason}`);
}

function printHelp(): void {
  const lines = [
    'Usage: engram [--json] <command> [options]',
    '',
    'Global options:',
    '  --vault <path>         Override vault path (otherwise uses env/config)',
    '  --engram-root <dir>    Override Engram root path inside the vault',
    '  --mode integrated|standalone',
    '  --read-paths a,b,c',
    '  --json                 Emit raw tool response JSON',
    '',
    'Commands:',
    '  soul get | set --content <text|->',
    '  thread resolve|get|list|set|update|merge|todo-add|todo-complete|todo-reopen|todo-remove|todo-list',
    '  context load --query <text>',
    '  scratch append|read|compact|prune|delete|clear',
    '  memory store|search|read|list|update|archive',
    '  inbox list|add|read|remove',
    '  note create|read|update|append|list|search|delete',
    '  skill list|get|store',
    '  conversation save --messages <json|-@file|->',
    '  tool <name> <json-args|->',
  ];

  for (const line of lines) {
    writeOut(line);
  }
}

async function main(): Promise<void> {
  const parsedGlobals = parseGlobalArgs(argv.slice(CLI_ARG_START_INDEX));

  if (parsedGlobals.help || parsedGlobals.commandTokens.length === 0) {
    printHelp();
    return;
  }

  const runtime = await resolveRuntimeConfig(parsedGlobals.runtimeOverrides);
  const memoryConfig = {
    ...defaultMemoryConfig(runtime.vaultPath, runtime.mode),
    ...(runtime.engramRoot === undefined ? {} : { engramRoot: runtime.engramRoot }),
    readPaths: runtime.readPaths,
  };
  const manager = new MemoryManager(new NodeAdapter(), memoryConfig);

  const invocation = await buildInvocation(parsedGlobals.commandTokens);
  const response = await executeToolCall({
    manager,
    name: invocation.name,
    args: invocation.args,
  });

  if (response.isError === true) {
    reportError(response);
    exit(1);
  }

  reportSuccess(response, parsedGlobals.json);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  writeErr(`err: ${message}`);
  exit(1);
});
