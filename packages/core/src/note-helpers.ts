import * as path from 'node:path';
import type { FileSystemAdapter } from './adapters/types.js';
import { supportsProcess, normalizeNoteContent } from './memory-helpers.js';
import { VaultNote } from './vault.js';

const BACKSLASH_PATTERN = /\\/gu;
const LEADING_OR_TRAILING_SLASHES_PATTERN = /^\/+|\/+$/gu;
const MARKDOWN_EXTENSION_PATTERN = /\.md$/u;

const EMPTY_CONTENT = '';
const DEFAULT_LIST_LIMIT = 20;
const INVALID_DATE_TIME = 0;

export function normalizeNotePrefix(prefix?: string): string | undefined {
  if (prefix === undefined) {
    return undefined;
  }

  return prefix
    .replace(BACKSLASH_PATTERN, '/')
    .replace(LEADING_OR_TRAILING_SLASHES_PATTERN, EMPTY_CONTENT);
}

export function matchesNotePrefix(relativePath: string, prefix?: string): boolean {
  if (prefix === undefined) {
    return true;
  }

  return relativePath === prefix || relativePath.startsWith(`${prefix}/`);
}

export function appendNoteContent(
  current: string,
  addition: string,
  separator: string,
): string {
  if (current.length === 0) {
    return addition;
  }
  if (addition.length === 0) {
    return current;
  }

  return `${current}${separator}${addition}`;
}

export function notePreview(content: string, maxChars: number): string {
  return content.slice(0, maxChars);
}

export function stripMarkdownExtension(pathValue: string): string {
  return pathValue.replace(MARKDOWN_EXTENSION_PATTERN, EMPTY_CONTENT);
}

export interface InboxNote {
  path: string;
  content: string;
  created: Date;
}

export interface SerializedInboxNote {
  path: string;
  content: string;
  created: string;
}

export async function mutateVaultNote(
  adapter: FileSystemAdapter,
  filePath: string,
  mutate: (note: VaultNote) => void,
): Promise<VaultNote> {
  if (supportsProcess(adapter)) {
    const finalSerialized = await adapter.process(filePath, (raw) => {
      const note = VaultNote.parse(filePath, raw);
      const before = note.serialize();
      mutate(note);

      if (note.serialize() === before) {
        return raw;
      }

      note.frontmatter.updated = new Date().toISOString();
      return note.serialize();
    });

    return VaultNote.parse(filePath, finalSerialized);
  }

  const note = await VaultNote.read(adapter, filePath);
  const before = note.serialize();
  mutate(note);
  if (note.serialize() === before) {
    return note;
  }

  await note.save(adapter);
  return note;
}

export async function updateRawNote(
  adapter: FileSystemAdapter,
  target: string,
  content: string,
  expectedCurrentContent?: string,
): Promise<string> {
  const targetExists = await adapter.exists(target);
  if (!targetExists) {
    throw new Error(`Note not found: ${target}`);
  }

  const nextContent = normalizeNoteContent(content);
  const expected = expectedCurrentContent === undefined
    ? undefined
    : normalizeNoteContent(expectedCurrentContent);

  if (supportsProcess(adapter)) {
    await adapter.process(target, (current) => {
      const normalizedCurrent = normalizeNoteContent(current);
      if (expected !== undefined && normalizedCurrent !== expected) {
        throw new Error(`Note changed since last read: ${target}`);
      }
      if (normalizedCurrent === nextContent) {
        return current;
      }

      return nextContent;
    });

    return target;
  }

  const current = normalizeNoteContent(await adapter.read(target));
  if (expected !== undefined && current !== expected) {
    throw new Error(`Note changed since last read: ${target}`);
  }
  if (current !== nextContent) {
    await adapter.write(target, nextContent);
  }

  return target;
}

export async function appendRawNote(
  adapter: FileSystemAdapter,
  target: string,
  content: string,
  options: {
    expectedCurrentContent?: string;
    separator?: string;
  } = {},
): Promise<string> {
  const addition = normalizeNoteContent(content);
  const expected = options.expectedCurrentContent === undefined
    ? undefined
    : normalizeNoteContent(options.expectedCurrentContent);
  const separator = normalizeNoteContent(options.separator ?? '\n\n');

  if (supportsProcess(adapter)) {
    await adapter.process(target, (current) => {
      const normalizedCurrent = normalizeNoteContent(current);
      if (expected !== undefined && normalizedCurrent !== expected) {
        throw new Error(`Note changed since last read: ${target}`);
      }

      return appendNoteContent(normalizedCurrent, addition, separator);
    });

    return target;
  }

  const fileExists = await adapter.exists(target);
  const current = fileExists
    ? normalizeNoteContent(await adapter.read(target))
    : EMPTY_CONTENT;
  if (expected !== undefined && current !== expected) {
    throw new Error(`Note changed since last read: ${target}`);
  }

  const nextContent = appendNoteContent(current, addition, separator);

  if (!fileExists) {
    await adapter.mkdir(path.dirname(target));
    await adapter.write(target, nextContent);
    return target;
  }
  if (current !== nextContent) {
    await adapter.write(target, nextContent);
  }

  return target;
}

export async function listRawNotes(
  adapter: FileSystemAdapter,
  notesRoot: string,
  options: {
    limit?: number;
    prefix?: string;
    noteRelativePath: (filePath: string) => string;
    readNote: (filePath: string) => Promise<string>;
    previewLength: number;
  },
): Promise<Array<{ path: string; preview: string }>> {
  const files = await adapter.list(notesRoot).catch(() => [] as string[]);
  const prefix = normalizeNotePrefix(options.prefix);

  const filtered = files
    .map((filePath) => options.noteRelativePath(filePath))
    .filter((relativePath) => matchesNotePrefix(relativePath, prefix))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, options.limit ?? DEFAULT_LIST_LIMIT);

  return await Promise.all(
    filtered.map(async (relativePath) => {
      const content = await options.readNote(relativePath);
      return {
        path: relativePath,
        preview: notePreview(content, options.previewLength),
      };
    }),
  );
}

export async function searchRawNotes(
  adapter: FileSystemAdapter,
  notesRoot: string,
  query: string,
  options: {
    limit?: number;
    noteRelativePath: (filePath: string) => string;
    previewLength: number;
  },
): Promise<Array<{ path: string; preview: string; score?: number }>> {
  const results = await adapter.search(query, notesRoot).catch(() => [] as Array<{
    path: string;
    content: string;
    score?: number;
  }>);

  return results
    .slice(0, options.limit ?? DEFAULT_LIST_LIMIT)
    .map((result) => ({
      path: options.noteRelativePath(result.path),
      preview: notePreview(result.content, options.previewLength),
      score: result.score,
    }));
}

export async function deleteRawNote(
  adapter: FileSystemAdapter,
  target: string,
): Promise<string> {
  const targetExists = await adapter.exists(target);
  if (!targetExists) {
    throw new Error(`Note not found: ${target}`);
  }

  await adapter.delete(target);
  return target;
}

export function createdDate(value: unknown): Date {
  return typeof value === 'string' ? new Date(value) : new Date(INVALID_DATE_TIME);
}

export function createdTimestamp(created: Date): string {
  return created.getTime() === INVALID_DATE_TIME ? EMPTY_CONTENT : created.toISOString();
}

export function serializeInboxNote(note: InboxNote): SerializedInboxNote {
  return {
    path: note.path,
    content: note.content,
    created: createdTimestamp(note.created),
  };
}

export async function readLegacyThreadInbox(
  adapter: FileSystemAdapter,
  threadId: string,
  normalizeNotePath: (filePath: string) => string,
  noteRelativePath: (filePath: string) => string,
): Promise<SerializedInboxNote | null> {
  const legacyCandidates = [
    normalizeNotePath(path.join('inbox', 'threads', threadId)),
    normalizeNotePath(path.join('inbox', threadId)),
  ];
  const existingCandidates = await Promise.all(
    legacyCandidates.map(async (legacyPath) =>
      await adapter.exists(legacyPath) ? legacyPath : null),
  );
  const legacyPath = existingCandidates.find((candidate): candidate is string => candidate !== null);
  if (legacyPath === undefined) {
    return null;
  }

  const raw = await adapter.read(legacyPath);
  const parsed = VaultNote.parse(legacyPath, raw);
  const created = createdDate(parsed.frontmatter.created);
  return serializeInboxNote({
    path: noteRelativePath(legacyPath),
    content: parsed.content.length > 0 ? parsed.content : raw,
    created,
  });
}

export async function listInboxNotes(
  listNotes: (options?: { limit?: number; prefix?: string }) => Promise<Array<{ path: string }>>,
  readNote: (filePath: string) => Promise<string>,
  prefix: string,
  options: {
    excludePrefix?: string;
    limit?: number;
  } = {},
): Promise<InboxNote[]> {
  const notes = await listNotes({ prefix, limit: options.limit ?? DEFAULT_LIST_LIMIT });
  const { excludePrefix } = options;
  const filtered = excludePrefix === undefined
    ? notes
    : notes.filter(({ path: notePath }) => !notePath.startsWith(excludePrefix));

  const detailed = await Promise.all(
    filtered.map(async (note) => {
      const raw = await readNote(note.path);
      const parsed = VaultNote.parse(note.path, raw);
      const created = createdDate(parsed.frontmatter.created);
      return {
        path: note.path,
        content: parsed.content.length > 0 ? parsed.content : raw,
        created: isNaN(created.getTime()) ? new Date(INVALID_DATE_TIME) : created,
      };
    }),
  );

  return detailed.sort((left, right) => left.created.getTime() - right.created.getTime());
}
