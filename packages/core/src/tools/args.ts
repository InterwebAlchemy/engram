import { inspect } from 'node:util';
import {
  BOOTSTRAP_STATES,
  CONFIDENCE_VALUES,
  JSON_INDENT,
} from './definitions';

const INSPECT_DEPTH = 2;
const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;

export interface ToolMessage {
  readonly content: string;
  readonly role: (typeof MESSAGE_ROLES)[number];
}

export type ToolArgs = Record<string, unknown>;

export interface ToolResponse {
  readonly content: Array<{
    readonly text: string;
    readonly type: 'text';
  }>;
  readonly isError?: true;
  [key: string]: unknown;
}

export function toolArgs(args: unknown): ToolArgs {
  if (args === null || typeof args !== 'object') {
    return {};
  }

  const normalized: ToolArgs = {};
  for (const [key, value] of Object.entries(args)) {
    normalized[key] = value;
  }
  return normalized;
}

export function textResult(text: string, isError = false): ToolResponse {
  return isError
    ? { content: [{ type: 'text', text }], isError: true }
    : { content: [{ type: 'text', text }] };
}

export function hasOwnArg(args: ToolArgs, key: string): boolean {
  return Object.hasOwn(args, key);
}

export function requireStringArg(args: ToolArgs, key: string): string {
  const { [key]: value } = args;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required string argument: ${key}`);
  }
  return value;
}

export function optionalStringArg(args: ToolArgs, key: string): string | undefined {
  const { [key]: value } = args;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected string argument: ${key}`);
  }
  return value;
}

export function optionalNumberArg(args: ToolArgs, key: string): number | undefined {
  const { [key]: value } = args;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number') {
    throw new Error(`Expected number argument: ${key}`);
  }
  return value;
}

export function optionalBooleanArg(args: ToolArgs, key: string): boolean | undefined {
  const { [key]: value } = args;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(`Expected boolean argument: ${key}`);
  }
  return value;
}

export function optionalStringArrayArg(args: ToolArgs, key: string): string[] | undefined {
  const { [key]: value } = args;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Expected string[] argument: ${key}`);
  }

  const strings: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      strings.push(item);
    }
  }
  return strings;
}

export function optionalMessagesArg(args: ToolArgs, key: string): ToolMessage[] | undefined {
  const { [key]: value } = args;
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => !isToolMessage(item))) {
    throw new Error(`Expected messages array argument: ${key}`);
  }

  const messages: ToolMessage[] = [];
  for (const item of value) {
    if (isToolMessage(item)) {
      messages.push(item);
    }
  }
  return messages;
}

export function requireEnumArg<T extends string>(
  args: ToolArgs,
  key: string,
  values: readonly T[],
): T {
  const value = requireStringArg(args, key);
  if (!isOneOf(value, values)) {
    throw new Error(`Invalid argument for ${key}: ${value}`);
  }
  return value;
}

export function optionalEnumArg<T extends string>(
  args: ToolArgs,
  key: string,
  values: readonly T[],
): T | undefined {
  const value = optionalStringArg(args, key);
  if (value === undefined) {
    return undefined;
  }
  if (!isOneOf(value, values)) {
    throw new Error(`Invalid argument for ${key}: ${value}`);
  }
  return value;
}

export function optionalMappedArg<T>(
  args: ToolArgs,
  key: string,
  map: Record<string, T>,
): T | undefined {
  const value = optionalStringArg(args, key);
  if (value === undefined) {
    return undefined;
  }
  const { [value]: mapped } = map;
  if (mapped === undefined) {
    throw new Error(`Invalid argument for ${key}: ${value}`);
  }
  return mapped;
}

export function requiredMappedArg<T>(
  args: ToolArgs,
  key: string,
  map: Record<string, T>,
): T {
  const value = requireStringArg(args, key);
  const { [value]: mapped } = map;
  if (mapped === undefined) {
    throw new Error(`Invalid argument for ${key}: ${value}`);
  }
  return mapped;
}

export function optionalBootstrapStateArg(
  args: ToolArgs,
  key: string,
): (typeof BOOTSTRAP_STATES)[number] | undefined {
  return optionalEnumArg(args, key, BOOTSTRAP_STATES);
}

export function optionalConfidenceArg(
  args: ToolArgs,
  key: string,
): (typeof CONFIDENCE_VALUES)[number] | undefined {
  return optionalEnumArg(args, key, CONFIDENCE_VALUES);
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value, null, JSON_INDENT);
}

export function formatUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return inspect(value, { depth: INSPECT_DEPTH });
}

function isOneOf<T extends string>(value: string, values: readonly T[]): value is T {
  return values.some((entry) => entry === value);
}

function isToolMessage(value: unknown): value is ToolMessage {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  if (!('content' in value) || !('role' in value)) {
    return false;
  }

  const {
    content,
    role,
  } = value;
  return typeof content === 'string'
    && typeof role === 'string'
    && isOneOf(role, MESSAGE_ROLES);
}
