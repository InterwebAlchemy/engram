import * as path from 'node:path';
import type { FileSystemAdapter } from './adapters/types';
import { MemoryState, MemoryType } from './types';
import type {
  MemoryConfig,
  MemoryFilters,
  ContextSection,
  TokenBudget,
  NoteFrontmatter,
  ThreadFields,
  Confidence,
  ScratchEntry,
  ScratchReadOptions,
  ScratchCompactOptions,
  ScratchPruneOptions,
  Message,
} from './types';
import { VaultNote } from './vault';
import { slugify } from './utils';
import type { Conversation } from './conversation';
import { KeywordSearchProvider } from './scoring';
import type { SearchProvider } from './scoring';
import { applyMemoryFilters } from './context-helpers';
import { normalizeNoteContent } from './memory-helpers';
import {
  appendRawNote,
  deleteRawNote,
  listRawNotes,
  mutateVaultNote,
  searchRawNotes,
  updateRawNote,
} from './note-helpers';
import {
  appendScratchEntry,
  compactScratchFile,
  pruneScratchFile,
  readScratchEntries,
} from './scratch-helpers';
import { MemoryContextOperations } from './memory-context-operations';
import { MemoryExtraOperations } from './memory-extra-operations';
import { ThreadOperations } from './thread-operations';

const MEMORY_SLUG_PREVIEW_LENGTH = 60;
const NOTE_PREVIEW_LENGTH = 200;
const DEFAULT_NOTE_SEARCH_LIMIT = 10;
const DEFAULT_SCRATCH_READ_LIMIT = 50;

interface StoreOptions { tags?: string[]; provider?: string; confidence?: Confidence; }

export class MemoryManager {
  private readonly writeRoot: string; private readonly readRoots: string[];
  private readonly contextOperations: MemoryContextOperations; private readonly searchProvider: SearchProvider;
  private readonly extraOperations: MemoryExtraOperations; private readonly threadOperations: ThreadOperations;

  constructor(
    private readonly adapter: FileSystemAdapter,
    private readonly config: MemoryConfig,
    searchProvider?: SearchProvider,
  ) {
    this.writeRoot = path.resolve(config.basePath, config.engramRoot);
    this.readRoots = [this.writeRoot, ...config.readPaths.map((p) => path.resolve(config.basePath, p))];
    this.searchProvider = searchProvider ?? new KeywordSearchProvider();
    this.contextOperations = new MemoryContextOperations({
      adapter: this.adapter,
      memoryDir: () => path.join(this.writeRoot, this.config.memoryPath),
      memoryTypeDir: (type) => this.memoryTypeDir(type),
      getGlobalInboxSummary: async (threadId) => await this.getGlobalInboxSummary(threadId),
      getThread: async (threadId) => await this.getThread(threadId),
      getThreadInboxSummary: async (threadId) => await this.getThreadInboxSummary(threadId),
      contextLabelFor: (note) => this.contextLabelFor(note),
      searchProvider: this.searchProvider,
    });
    this.extraOperations = new MemoryExtraOperations({
      assertWriteAllowed: (filePath) => {
        this.assertWriteAllowed(filePath);
      },
      adapter: this.adapter,
      archiveDir: () => this.archiveDir(),
      memoryTypeDir: (type) => this.memoryTypeDir(type),
      writeRoot: this.writeRoot,
      listMemories: async (filters) => await this.list(filters),
      conversationDir: (dateStr) => this.conversationDir(dateStr),
    });
    this.threadOperations = new ThreadOperations({
      adapter: this.adapter,
      assertWriteAllowed: (filePath) => {
        this.assertWriteAllowed(filePath);
      },
      createNote: async (filePath, content) => await this.createNote(filePath, content),
      deleteNote: async (filePath) => await this.deleteNote(filePath),
      listNotes: async (options) => await this.listNotes(options),
      readNote: async (filePath) => await this.readNote(filePath),
      normalizeNotePath: (filePath) => this.normalizeNotePath(filePath),
      noteRelativePath: (filePath) => this.noteRelativePath(filePath),
      listMemories: async (filters) => await this.list(filters),
      updateMemory: async (filePath, content, frontmatterUpdates) =>
        await this.update(filePath, content, frontmatterUpdates),
      threadDir: () => this.threadDir(),
      threadPath: (threadId) => this.threadPath(threadId),
      mutateThread: async (filePath, transform) => await this.mutateVaultNoteContent(filePath, transform),
    });
  }

  // ─── Write-scope enforcement ──────────────────────────────────────────────

  private assertWriteAllowed(filePath: string): void {
    const target = path.resolve(filePath);
    const isAllowed =
      target === this.writeRoot ||
      target.startsWith(this.writeRoot + path.sep);

    if (!isAllowed) {
      throw new Error(
        `Write denied: "${filePath}" is outside the engram write scope ("${this.writeRoot}")`,
      );
    }
  }

  // ─── Path helpers ─────────────────────────────────────────────────────────

  /**
   * Normalize a user-provided path:
   * - Absolute paths are returned as-is.
   * - Relative paths are resolved against the write root.
   * - `.md` is appended if no extension is present.
   */
  private normalizePath(filePath: string): string {
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.writeRoot, filePath);
    return path.extname(resolved).length > 0 ? resolved : `${resolved}.md`;
  }

  /**
   * Map MemoryType enum values to their vault directory names.
   * Human-readable types use plural directory names to match the vault structure.
   */
  private static readonly TYPE_DIRS: Partial<Record<string, string>> = {
    [MemoryType.Fact]: 'facts',
    [MemoryType.Entity]: 'entities',
    [MemoryType.Reflection]: 'reflections',
    [MemoryType.Skill]: 'skills',
  };

  private memoryTypeDir(type: MemoryType | string): string {
    const dirName = MemoryManager.TYPE_DIRS[type] ?? type;
    return path.join(this.writeRoot, this.config.memoryPath, dirName);
  }

  private notesDir(): string { return path.join(this.writeRoot, this.config.notesPath); }

  private threadDir(): string { return path.join(this.writeRoot, this.config.threadsPath); }

  private threadPath(threadId: string): string { return path.join(this.threadDir(), `${threadId}.md`); }

  private contextLabelFor(note: VaultNote): string {
    const memoryRoot = path.join(this.writeRoot, this.config.memoryPath);
    return `memory:${path.relative(memoryRoot, note.path)}`;
  }

  private conversationDir(dateStr?: string): string {
    return dateStr === undefined
      ? path.join(this.writeRoot, this.config.conversationsPath)
      : path.join(this.writeRoot, this.config.conversationsPath, dateStr);
  }

  private normalizeNotePath(filePath: string): string {
    const notesRoot = this.notesDir();
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(notesRoot, filePath);
    const withExt = path.extname(resolved).length > 0 ? resolved : `${resolved}.md`;

    if (withExt === notesRoot || withExt.startsWith(notesRoot + path.sep)) {
      return withExt;
    }

    throw new Error(
      `Note path must stay within the notes directory ("${notesRoot}")`,
    );
  }

  private noteRelativePath(filePath: string): string { return path.relative(this.notesDir(), filePath); }

  private archiveDir(): string { return path.join(this.writeRoot, this.config.archivePath); }

  private async mutateVaultNoteContent(
    filePath: string,
    transform: (content: string) => string,
  ): Promise<VaultNote> {
    this.assertWriteAllowed(filePath);
    return await mutateVaultNote(this.adapter, filePath, (note) => {
      const vaultNote = note;
      vaultNote.content = transform(vaultNote.content);
    });
  }

  // ─── Core memory operations ───────────────────────────────────────────────

  /**
   * Store a new memory note in the vault.
   * The note is created under engram/<memoryPath>/<type>/<slug>.md.
   */
  async store(content: string, type: MemoryType, options: StoreOptions = {}): Promise<VaultNote> {
    const now = new Date();
    const slug = slugify(content.slice(0, MEMORY_SLUG_PREVIEW_LENGTH));
    const dir = this.memoryTypeDir(type);
    const filePath = path.join(dir, `${slug}.md`);
    const {
      tags = [],
      provider,
      confidence,
    } = options;

    this.assertWriteAllowed(filePath);
    await this.adapter.mkdir(dir);

    const frontmatter: NoteFrontmatter = {
      type,
      created: now.toISOString(),
      updated: now.toISOString(),
      tags,
      memory_state: MemoryState.Default,
      ...(provider === undefined ? {} : { provider }),
      ...(confidence === undefined ? {} : { confidence }),
    };

    return await VaultNote.create(this.adapter, filePath, frontmatter, content);
  }

  /**
   * Search memories by keyword query with optional frontmatter filters.
   */
  async search(query: string, filters?: MemoryFilters): Promise<VaultNote[]> {
    const dir = path.join(this.writeRoot, this.config.memoryPath);
    const results = await this.adapter.search(query, dir);

    const notes = await Promise.all(
      results.map(async (r) => await VaultNote.read(this.adapter, r.path).catch(() => null)),
    );

    return applyMemoryFilters(
      notes.filter((n): n is VaultNote => n !== null),
      filters,
    );
  }

  /**
   * Read a specific note. Path must be within configured read roots.
   */
  async read(filePath: string): Promise<VaultNote> {
    const target = this.normalizePath(filePath);
    const allowed = this.readRoots.some(
      (root) => target === root || target.startsWith(root + path.sep),
    );

    if (!allowed) {
      throw new Error(
        `Read denied: "${filePath}" is outside configured read paths`,
      );
    }

    return await VaultNote.read(this.adapter, target);
  }

  /**
   * Update an existing memory note's content and/or frontmatter.
   */
  async update(
    filePath: string,
    content?: string,
    frontmatterUpdates?: Partial<NoteFrontmatter>,
  ): Promise<VaultNote> {
    const target = this.normalizePath(filePath);
    this.assertWriteAllowed(target);

    const note = await VaultNote.read(this.adapter, target);

    if (content !== undefined) {
      note.content = content;
    }
    if (frontmatterUpdates !== undefined) {
      note.updateFrontmatter(frontmatterUpdates);
    }

    await note.save(this.adapter);
    return note;
  }

  /**
   * List all memory notes under the memory path, with optional filters.
   */
  async list(filters?: MemoryFilters): Promise<VaultNote[]> {
    const dir = path.join(this.writeRoot, this.config.memoryPath);
    const files = await this.adapter.list(dir);

    const notes = await Promise.all(
      files.map(async (f) => await VaultNote.read(this.adapter, f).catch(() => null)),
    );

    return applyMemoryFilters(
      notes.filter((n): n is VaultNote => n !== null),
      filters,
    );
  }

  async getContext(query: string, budget: TokenBudget, threadId?: string): Promise<ContextSection[]> {
    return await this.contextOperations.getContext(query, budget, threadId);
  }

  /**
   * Read the soul document, or return null if it doesn't exist yet.
   */
  async getSoulDocument(): Promise<VaultNote | null> {
    return await this.extraOperations.getSoulDocument();
  }

  /**
   * Write (or overwrite) the soul document.
   * Always stored at engram/memory/reflection/soul.md with type=reflection
   * and memory_state=core.
   */
  async setSoulDocument(content: string): Promise<VaultNote> {
    return await this.extraOperations.setSoulDocument(content);
  }

  // ─── Thread operations ────────────────────────────────────────────────────

  async getThread(threadId: string): Promise<VaultNote | null> {
    return await this.threadOperations.getThread(threadId);
  }

  async setThread(threadId: string, content: string, fields: ThreadFields = {}): Promise<VaultNote> {
    return await this.threadOperations.setThread(threadId, content, fields);
  }

  async updateThread(threadId: string, content?: string, fields?: ThreadFields): Promise<VaultNote> {
    return await this.threadOperations.updateThread(threadId, content, fields);
  }

  async listThreads(): Promise<VaultNote[]> {
    return await this.threadOperations.listThreads();
  }

  async listThreadTodos(
    threadId: string,
    options: { includeCompleted?: boolean } = {},
  ): Promise<Array<{ text: string; checked: boolean }>> {
    return await this.threadOperations.listThreadTodos(threadId, options);
  }

  async addThreadTodo(
    threadId: string,
    itemText: string,
    options: { prepend?: boolean } = {},
  ): Promise<VaultNote> {
    return await this.threadOperations.addThreadTodo(threadId, itemText, options);
  }

  async completeThreadTodo(threadId: string, itemText: string): Promise<VaultNote> {
    return await this.threadOperations.completeThreadTodo(threadId, itemText);
  }

  async reopenThreadTodo(threadId: string, itemText: string): Promise<VaultNote> {
    return await this.threadOperations.reopenThreadTodo(threadId, itemText);
  }

  async removeThreadTodo(threadId: string, itemText: string): Promise<VaultNote> {
    return await this.threadOperations.removeThreadTodo(threadId, itemText);
  }

  async listThreadInbox(
    threadId: string,
  ): Promise<Array<{ path: string; content: string; created: string }>> {
    return await this.threadOperations.listThreadInbox(threadId);
  }

  async addThreadInboxItem(threadId: string, itemText: string): Promise<string> {
    return await this.threadOperations.addThreadInboxItem(threadId, itemText);
  }

  async completeThreadInboxItem(threadId: string, item: string): Promise<string> {
    return await this.threadOperations.completeThreadInboxItem(threadId, item);
  }

  async removeThreadInboxItem(threadId: string, item: string): Promise<string> {
    return await this.threadOperations.removeThreadInboxItem(threadId, item);
  }

  async getThreadInboxSummary(threadId: string): Promise<string | null> {
    return await this.threadOperations.getThreadInboxSummary(threadId);
  }

  async listGlobalInbox(): Promise<Array<{ path: string; content: string; created: string }>> {
    return await this.threadOperations.listGlobalInbox();
  }

  async addGlobalInboxItem(content: string, name?: string): Promise<string> {
    return await this.threadOperations.addGlobalInboxItem(content, name);
  }

  async removeInboxItem(itemPath: string): Promise<string> {
    return await this.threadOperations.removeInboxItem(itemPath);
  }

  async getGlobalInboxSummary(activeThreadId?: string): Promise<string | null> {
    return await this.threadOperations.getGlobalInboxSummary(activeThreadId);
  }
  async resolveThread(hints: {
    cwd?: string;
    gitRemote?: string;
    autoCreate?: boolean;
  }): Promise<{ threadId: string; created: boolean; thread: VaultNote }> {
    return await this.threadOperations.resolveThread(hints);
  }

  async mergeThreads(
    sourceId: string,
    targetId: string,
  ): Promise<{ retaggedCount: number }> {
    return await this.threadOperations.mergeThreads(sourceId, targetId);
  }

  // ─── Skill operations ─────────────────────────────────────────────────────

  /**
   * Store or overwrite a skill by slug.
   * Skills live at engram/memory/skill/{slug}.md and default to Core state
   * so they are always available for retrieval but loaded on demand, not
   * auto-injected like soul.
   */
  async storeSkill(slug: string, content: string, tags: string[] = []): Promise<VaultNote> {
    return await this.extraOperations.storeSkill(slug, content, tags);
  }

  /**
   * Retrieve a skill by slug. Returns null if not found.
   */
  async getSkill(slug: string): Promise<VaultNote | null> {
    return await this.extraOperations.getSkill(slug);
  }

  /**
   * List all stored skills.
   */
  async listSkills(): Promise<VaultNote[]> {
    return await this.extraOperations.listSkills();
  }

  // ─── Note operations ──────────────────────────────────────────────────────

  /**
   * Create a raw markdown note under engram/notes.
   * Fails if the target path already exists.
   */
  async createNote(filePath: string, content: string): Promise<string> {
    const target = this.normalizeNotePath(filePath);
    this.assertWriteAllowed(target);

    if (await this.adapter.exists(target)) {
      throw new Error(`Note already exists: ${target}`);
    }

    await this.adapter.mkdir(path.dirname(target));
    await this.adapter.write(target, normalizeNoteContent(content));
    return target;
  }

  /**
   * Read a raw note from engram/notes.
   */
  async readNote(filePath: string): Promise<string> {
    const target = this.normalizeNotePath(filePath);
    return await this.adapter.read(target);
  }

  /**
   * Overwrite an existing raw note under engram/notes.
   */
  async updateNote(
    filePath: string,
    content: string,
    expectedCurrentContent?: string,
  ): Promise<string> {
    const target = this.normalizeNotePath(filePath);
    this.assertWriteAllowed(target);
    return await updateRawNote(this.adapter, target, content, expectedCurrentContent);
  }

  /**
   * Append markdown content to a raw note under engram/notes.
   * Creates the note if it does not exist yet.
   */
  async appendNote(
    filePath: string,
    content: string,
    options: {
      expectedCurrentContent?: string;
      separator?: string;
    } = {},
  ): Promise<string> {
    const target = this.normalizeNotePath(filePath);
    this.assertWriteAllowed(target);
    return await appendRawNote(this.adapter, target, content, options);
  }

  /**
   * List markdown notes under engram/notes.
   */
  async listNotes(options: {
    limit?: number;
    prefix?: string;
  } = {}): Promise<Array<{ path: string; preview: string }>> {
    return await listRawNotes(
      this.adapter,
      this.notesDir(),
      {
        ...options,
        noteRelativePath: (filePath) => this.noteRelativePath(filePath),
        readNote: async (filePath) => await this.readNote(filePath),
        previewLength: NOTE_PREVIEW_LENGTH,
      },
    );
  }

  /**
   * Search markdown notes under engram/notes.
   */
  async searchNotes(
    query: string,
    options: { limit?: number } = {},
  ): Promise<Array<{ path: string; preview: string; score?: number }>> {
    return await searchRawNotes(
      this.adapter,
      this.notesDir(),
      query,
      {
        limit: options.limit ?? DEFAULT_NOTE_SEARCH_LIMIT,
        noteRelativePath: (filePath) => this.noteRelativePath(filePath),
        previewLength: NOTE_PREVIEW_LENGTH,
      },
    );
  }

  /**
   * Delete an existing raw note from engram/notes.
   */
  async deleteNote(filePath: string): Promise<string> {
    const target = this.normalizeNotePath(filePath);
    this.assertWriteAllowed(target);
    return await deleteRawNote(this.adapter, target);
  }

  // ─── Scratch operations ───────────────────────────────────────────────────

  private get scratchFilePath(): string {
    return path.join(this.writeRoot, this.config.scratchFile);
  }

  /**
   * Append an entry to the shared scratch log.
   * Each entry is prefixed with the session ID and an ISO timestamp.
   * Newlines in content are collapsed to keep entries single-line.
   */
  async appendScratch(sessionId: string, content: string): Promise<void> {
    const { scratchFilePath: logPath } = this;
    this.assertWriteAllowed(logPath);
    await appendScratchEntry(this.adapter, logPath, sessionId, content);
  }

  /**
   * Read scratch log entries, with optional filtering and pagination.
   * Returns entries sorted oldest-first. Applies limit after filtering.
   */
  async readScratch(options: ScratchReadOptions = {}): Promise<ScratchEntry[]> {
    return await readScratchEntries(this.adapter, this.scratchFilePath, options, {
      bootstrapLimit: DEFAULT_NOTE_SEARCH_LIMIT,
      defaultLimit: DEFAULT_SCRATCH_READ_LIMIT,
    });
  }

  /**
   * Compact scratch entries for a session. Finds entries for the given session
   * older than thresholdMs, removes them, and inserts a single replacement entry
   * containing the agent-provided synthesized content.
   */
  async compactScratch(options: ScratchCompactOptions): Promise<void> {
    const { scratchFilePath: logPath } = this;
    this.assertWriteAllowed(logPath);
    await compactScratchFile(this.adapter, logPath, options);
  }

  /**
   * Remove scratch entries for a session older than thresholdMs.
   * Returns the number of entries deleted.
   */
  async pruneScratch(options: ScratchPruneOptions): Promise<number> {
    const { scratchFilePath: logPath } = this;
    this.assertWriteAllowed(logPath);
    return await pruneScratchFile(this.adapter, logPath, options);
  }

  /**
   * Hard-delete the scratch log.
   * Scratch is explicitly ephemeral — deletion is permanent with no archiving.
   */
  async clearScratch(): Promise<void> {
    const { scratchFilePath: logPath } = this;
    this.assertWriteAllowed(logPath);
    await this.adapter.delete(logPath).catch(() => undefined);
  }

  /**
   * Move all forgotten memory notes to the archive directory, preserving their
   * relative path structure under engram/archive/.
   *
   * Optionally restrict to notes that have been forgotten for at least
   * `olderThanDays` days (based on the `updated` timestamp, which is set when
   * a note is marked forgotten).
   *
   * Returns the list of paths that were archived.
   */
  async archiveForgotten(olderThanDays?: number): Promise<string[]> {
    return await this.extraOperations.archiveForgotten(olderThanDays);
  }

  // ─── Conversation persistence ─────────────────────────────────────────────

  /**
   * Save a Conversation to the vault as a dated markdown file.
   * Returns the written VaultNote.
   */
  async saveConversation(
    conversation: Conversation,
    slug?: string,
  ): Promise<VaultNote> {
    return await this.extraOperations.saveConversation(conversation, slug);
  }

  /**
   * Create and save a conversation from a raw messages array.
   */
  async storeConversation(
    messages: Array<Pick<Message, 'role' | 'content'>>,
    summary?: string,
    tags: string[] = [],
    slug?: string,
  ): Promise<VaultNote> {
    return await this.extraOperations.storeConversation(messages, summary, tags, slug);
  }
}
