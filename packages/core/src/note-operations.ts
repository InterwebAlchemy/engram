import * as path from 'node:path';
import type { FileSystemAdapter } from './adapters/types.js';
import { normalizeNoteContent } from './memory-helpers.js';
import {
  appendRawNote,
  deleteRawNote,
  listRawNotes,
  searchRawNotes,
  updateRawNote,
} from './note-helpers.js';

const NOTE_PREVIEW_LENGTH = 200;
const DEFAULT_NOTE_SEARCH_LIMIT = 10;

export interface NoteOperationDependencies {
  adapter: FileSystemAdapter;
  assertWriteAllowed: (filePath: string) => void;
  notesDir: () => string;
  inboxDir: () => string;
  normalizeNotePath: (filePath: string) => string;
  noteRelativePath: (filePath: string) => string;
}

export class NoteOperations {
  constructor(private readonly deps: NoteOperationDependencies) {}

  async createNote(filePath: string, content: string): Promise<string> {
    const target = this.deps.normalizeNotePath(filePath);
    this.deps.assertWriteAllowed(target);

    if (await this.deps.adapter.exists(target)) {
      throw new Error(`Note already exists: ${target}`);
    }

    await this.deps.adapter.mkdir(path.dirname(target));
    await this.deps.adapter.write(target, normalizeNoteContent(content));
    return target;
  }

  async readNote(filePath: string): Promise<string> {
    const target = this.deps.normalizeNotePath(filePath);
    return await this.deps.adapter.read(target);
  }

  async updateNote(
    filePath: string,
    content: string,
    expectedCurrentContent?: string,
  ): Promise<string> {
    const target = this.deps.normalizeNotePath(filePath);
    this.deps.assertWriteAllowed(target);
    return await updateRawNote(this.deps.adapter, target, content, expectedCurrentContent);
  }

  async appendNote(
    filePath: string,
    content: string,
    options: {
      expectedCurrentContent?: string;
      separator?: string;
    } = {},
  ): Promise<string> {
    const target = this.deps.normalizeNotePath(filePath);
    this.deps.assertWriteAllowed(target);
    return await appendRawNote(this.deps.adapter, target, content, options);
  }

  async listNotes(options: {
    limit?: number;
    prefix?: string;
  } = {}): Promise<Array<{ path: string; preview: string }>> {
    const { prefix } = options;
    const isInboxPrefix = prefix !== undefined &&
      (prefix === 'inbox' || prefix.startsWith('inbox/') || prefix.startsWith('inbox\\'));

    // When prefix targets inbox, scan the inbox directory but keep the prefix
    // intact — noteRelativePath returns 'inbox/...' for inbox files, so the
    // prefix filter still matches correctly.
    const scanRoot = isInboxPrefix ? this.deps.inboxDir() : this.deps.notesDir();

    return await listRawNotes(
      this.deps.adapter,
      scanRoot,
      {
        ...options,
        prefix,
        noteRelativePath: (filePath) => this.deps.noteRelativePath(filePath),
        readNote: async (notePath) => await this.readNote(notePath),
        previewLength: NOTE_PREVIEW_LENGTH,
      },
    );
  }

  async searchNotes(
    query: string,
    options: { limit?: number } = {},
  ): Promise<Array<{ path: string; preview: string; score?: number }>> {
    return await searchRawNotes(
      this.deps.adapter,
      this.deps.notesDir(),
      query,
      {
        limit: options.limit ?? DEFAULT_NOTE_SEARCH_LIMIT,
        noteRelativePath: (filePath) => this.deps.noteRelativePath(filePath),
        previewLength: NOTE_PREVIEW_LENGTH,
      },
    );
  }

  async deleteNote(filePath: string): Promise<string> {
    const target = this.deps.normalizeNotePath(filePath);
    this.deps.assertWriteAllowed(target);
    return await deleteRawNote(this.deps.adapter, target);
  }
}
