import * as os from 'node:os';
import { ThreadStatus } from './types.js';
import type { FileSystemAdapter } from './adapters/types.js';
import type { VaultNote } from './vault.js';

const NORMALIZED_LINE_ENDINGS_PATTERN = /\r\n?/gu;
const WHITESPACE_PATTERN = /\s+/gu;
const ANY_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+\S/u;
const ANY_MARKDOWN_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+/u;
const PRIMARY_HEADING_PATTERN = /^\s{0,3}#\s+/u;
const CHECKLIST_ITEM_PATTERN =
  /^\s*(?:[*-]|\d+\.)\s+\[(?<checked>[ xX])\]\s+(?<text>.+?)\s*$/u;
const TODO_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+todos?\s*$/iu;
const INBOX_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+inbox\s*$/iu;
const MARKDOWN_EXTENSION_PATTERN = /\.md$/iu;

const MAX_TRUNCATION_ELLIPSIS_WIDTH = 1;
const THREAD_DESCRIPTION_PREVIEW_LENGTH = 180;
const GOAL_PREVIEW_LENGTH = 120;
const INBOX_PREVIEW_LENGTH = 140;
const MAX_THREAD_SUMMARY_GOALS = 3;

interface ChecklistSectionMatch {
  headingIndex: number;
  bodyStartIndex: number;
  endIndex: number;
}

interface ChecklistItem {
  text: string;
  checked: boolean;
  lineIndex: number;
}

interface ChecklistOptions {
  includeCompleted?: boolean;
  limit?: number;
}

interface ChecklistMutationOptions {
  headingPattern: RegExp;
  headingLabel: string;
  itemText: string;
}

export interface ProcessCapableAdapter extends FileSystemAdapter {
  process: (path: string, fn: (content: string) => string) => Promise<string>;
}

function checklistItemFromMatch(
  match: RegExpExecArray,
  lineIndex: number,
  includeCompleted: boolean,
): ChecklistItem | null {
  const { groups } = match;
  if (groups === undefined) {
    return null;
  }

  const { checked: rawChecked, text: rawText } = groups;
  const checked = rawChecked.toLowerCase() === 'x';
  if (checked && !includeCompleted) {
    return null;
  }

  return {
    text: normalizeChecklistText(rawText),
    checked,
    lineIndex,
  };
}

export function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
    : [];
}

function truncateInline(text: string, maxChars: number): string {
  const normalized = text.replace(WHITESPACE_PATTERN, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  const sliceLength = Math.max(0, maxChars - MAX_TRUNCATION_ELLIPSIS_WIDTH);
  return `${normalized.slice(0, sliceLength).trimEnd()}…`;
}

function normalizeChecklistText(text: string): string {
  return text.replace(WHITESPACE_PATTERN, ' ').trim();
}

function findChecklistSection(
  lines: string[],
  headingPattern: RegExp,
): ChecklistSectionMatch | null {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!headingPattern.test(line)) {
      continue;
    }

    const { length } = lines;
    let endIndex = length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? '';
      if (ANY_HEADING_PATTERN.test(candidate)) {
        endIndex = cursor;
        break;
      }
    }

    return {
      headingIndex: index,
      bodyStartIndex: index + 1,
      endIndex,
    };
  }

  return null;
}

function ensureChecklistSection(
  lines: string[],
  heading: string,
  headingPattern: RegExp,
): ChecklistSectionMatch {
  const existing = findChecklistSection(lines, headingPattern);
  if (existing !== null) {
    return existing;
  }

  if (lines.length === 1 && lines[0] === '') {
    lines.splice(0, 1);
  }

  const lastLine = lines.at(-1);
  if (lastLine !== undefined && lastLine.trim() !== '') {
    lines.push('');
  }

  lines.push(`## ${heading}`);
  return {
    headingIndex: lines.length - 1,
    bodyStartIndex: lines.length,
    endIndex: lines.length,
  };
}

export function extractChecklistItems(
  content: string,
  headingPattern: RegExp,
  options: ChecklistOptions = {},
): ChecklistItem[] {
  const lines = normalizeNoteContent(content).split('\n');
  const section = findChecklistSection(lines, headingPattern);
  if (section === null) {
    return [];
  }

  const items: ChecklistItem[] = [];
  const { bodyStartIndex, endIndex } = section;
  for (let index = bodyStartIndex; index < endIndex; index += 1) {
    const line = lines[index] ?? '';
    const match = CHECKLIST_ITEM_PATTERN.exec(line);
    if (match === null) {
      continue;
    }

    const item = checklistItemFromMatch(
      match,
      index,
      options.includeCompleted === true,
    );
    if (item === null) {
      continue;
    }
    items.push(item);

    const limit = options.limit ?? Number.POSITIVE_INFINITY;
    if (items.length >= limit) {
      break;
    }
  }

  return items;
}

function summarizeChecklist(label: string, items: ChecklistItem[]): string | null {
  if (items.length === 0) {
    return null;
  }

  return [
    `${label}:`,
    ...items.map((item) => `- [ ] ${truncateInline(item.text, GOAL_PREVIEW_LENGTH)}`),
  ].join('\n');
}

function findMatchingChecklistItems(
  content: string,
  headingPattern: RegExp,
  itemText: string,
): ChecklistItem[] {
  const normalizedTarget = normalizeChecklistText(itemText);
  return extractChecklistItems(content, headingPattern, { includeCompleted: true }).filter(
    (item) => normalizeChecklistText(item.text) === normalizedTarget,
  );
}

function formatChecklistState(checked: boolean): string {
  return checked ? 'x' : ' ';
}

export function expandHome(filePath: string): string {
  return filePath.startsWith('~') ? os.homedir() + filePath.slice(1) : filePath;
}

export function supportsProcess(
  adapter: FileSystemAdapter,
): adapter is ProcessCapableAdapter {
  return 'process' in adapter && typeof adapter.process === 'function';
}

export function normalizeNoteContent(content: string): string {
  return content.replace(NORMALIZED_LINE_ENDINGS_PATTERN, '\n');
}

export function summaryOnly(note: VaultNote): string | null {
  return readNonEmptyString(note.frontmatter.summary);
}

export function getTodoHeadingPattern(): RegExp {
  return TODO_HEADING_PATTERN;
}

export function threadInboxPrefix(threadId: string): string {
  return `inbox/threads/${threadId}`;
}

export function addChecklistItem(
  content: string,
  options: ChecklistMutationOptions & {
    heading: string;
    prepend?: boolean;
  },
): string {
  const normalizedContent = normalizeNoteContent(content);
  const lines = normalizedContent.length > 0 ? normalizedContent.split('\n') : [''];
  const {
    heading,
    headingPattern,
    itemText,
    prepend = false,
  } = options;
  const section = ensureChecklistSection(lines, heading, headingPattern);
  const matches = findMatchingChecklistItems(lines.join('\n'), headingPattern, itemText);

  if (matches.length > 1) {
    throw new Error(`Multiple checklist items match "${itemText}" in ${heading}.`);
  }

  if (matches.length === 1) {
    const [match] = matches;
    if (!match.checked) {
      return lines.join('\n');
    }

    lines[match.lineIndex] = `- [ ] ${itemText.trim()}`;
    return lines.join('\n');
  }

  const insertionIndex = prepend ? section.bodyStartIndex : section.endIndex;
  lines.splice(insertionIndex, 0, `- [ ] ${itemText.trim()}`);
  return lines.join('\n');
}

export function updateChecklistItemState(
  content: string,
  options: ChecklistMutationOptions & { checked: boolean },
): string {
  const lines = normalizeNoteContent(content).split('\n');
  const {
    headingPattern,
    headingLabel,
    itemText,
    checked,
  } = options;
  const matches = findMatchingChecklistItems(lines.join('\n'), headingPattern, itemText);

  if (matches.length === 0) {
    throw new Error(`${headingLabel} item not found: ${itemText}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple ${headingLabel.toLowerCase()} items match "${itemText}".`);
  }

  const [match] = matches;
  lines[match.lineIndex] = `- [${formatChecklistState(checked)}] ${itemText.trim()}`;
  return lines.join('\n');
}

export function removeChecklistItem(
  content: string,
  options: ChecklistMutationOptions,
): string {
  const lines = normalizeNoteContent(content).split('\n');
  const { headingPattern, headingLabel, itemText } = options;
  const matches = findMatchingChecklistItems(lines.join('\n'), headingPattern, itemText);

  if (matches.length === 0) {
    throw new Error(`${headingLabel} item not found: ${itemText}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple ${headingLabel.toLowerCase()} items match "${itemText}".`);
  }

  const [match] = matches;
  lines.splice(match.lineIndex, 1);
  return lines.join('\n');
}

export function summarizeThread(thread: VaultNote): string {
  const lines: string[] = [];
  const threadName =
    readNonEmptyString(thread.frontmatter.name) ??
    readNonEmptyString(thread.frontmatter.thread_id) ??
    thread.path;
  const status =
    readNonEmptyString(thread.frontmatter.status) ?? ThreadStatus.Active;

  lines.push(`Thread: ${threadName}`);
  lines.push(`Status: ${status}`);

  const description = readNonEmptyString(thread.frontmatter.description);
  if (description !== null) {
    lines.push(`Description: ${truncateInline(description, THREAD_DESCRIPTION_PREVIEW_LENGTH)}`);
  }

  const goals = readStringArray(thread.frontmatter.goals).slice(0, MAX_THREAD_SUMMARY_GOALS);
  if (goals.length > 0) {
    lines.push('Goals:');
    for (const goal of goals) {
      lines.push(`- ${truncateInline(goal, GOAL_PREVIEW_LENGTH)}`);
    }
  }

  const todoSummary = summarizeChecklist(
    'Todo',
    extractChecklistItems(thread.content, TODO_HEADING_PATTERN, { limit: 5 }),
  );
  if (todoSummary !== null) {
    lines.push(todoSummary);
  }

  return lines.join('\n');
}

function firstNonHeadingLine(content: string): string | null {
  const lines = normalizeNoteContent(content).split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    if (ANY_MARKDOWN_HEADING_PATTERN.test(rawLine)) {
      continue;
    }

    return line;
  }

  return null;
}

function inferInboxNoteTitle(relativePath: string, content: string): string {
  const heading = normalizeNoteContent(content)
    .split('\n')
    .find((line) => PRIMARY_HEADING_PATTERN.test(line))
    ?.replace(PRIMARY_HEADING_PATTERN, '')
    .trim();
  if (heading !== undefined && heading.length > 0) {
    return heading;
  }

  const basename = relativePath.split('/').pop() ?? relativePath;
  return basename.replace(MARKDOWN_EXTENSION_PATTERN, '');
}

export function summarizeInboxNote(relativePath: string, content: string): string {
  const title = inferInboxNoteTitle(relativePath, content);
  const checklist = extractChecklistItems(content, INBOX_HEADING_PATTERN, { limit: 3 });
  if (checklist.length > 0) {
    const checklistPreview = checklist.map((item) => item.text).join('; ');
    return `${title} (${relativePath}): ${checklistPreview}`;
  }

  const preview = firstNonHeadingLine(content) ?? '(empty note)';
  return `${title} (${relativePath}): ${truncateInline(preview, INBOX_PREVIEW_LENGTH)}`;
}
