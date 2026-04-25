import * as path from 'node:path';
import type { FileSystemAdapter } from './adapters/types.js';
import { MemoryState, MemoryType } from './types.js';
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
  ScratchDeleteOptions,
  ScratchPruneOptions,
  Message,
} from './types.js';
import { VaultNote } from './vault.js';
import { slugify } from './utils.js';
import type { Conversation } from './conversation.js';
import { KeywordSearchProvider } from './scoring.js';
import type { SearchProvider } from './scoring.js';
import { applyMemoryFilters } from './context-helpers.js';
import { mutateVaultNote } from './note-helpers.js';
import { NoteOperations } from './note-operations.js';
import {
  appendScratchEntry,
  compactScratchFile,
  deleteScratchFile,
  extractFirstPendingDream,
  pruneScratchFile,
  readAllScratchEntries,
  readScratchEntries,
  sweepScratchFile,
} from './scratch-helpers.js';
import type { PendingDream } from './scratch-helpers.js';
import { MemoryContextOperations } from './memory-context-operations.js';
import { MemoryExtraOperations } from './memory-extra-operations.js';
import { ThreadOperations, type ResolvedThread } from './thread-operations.js';
import type { GitRemoteDetector } from './git-remote.js';
import type { PackageNameDetector } from './package-name.js';

const MEMORY_SLUG_PREVIEW_LENGTH = 60;
const DEFAULT_BOOTSTRAP_LIMIT = 5;
const DEFAULT_SCRATCH_READ_LIMIT = 50;

interface StoreOptions { tags?: string[]; provider?: string; confidence?: Confidence; }

export interface MemoryManagerOptions {
  searchProvider?: SearchProvider;
  detectGitRemote?: GitRemoteDetector;
  detectPackageNames?: PackageNameDetector;
}

export class MemoryManager {
  private readonly writeRoot: string; private readonly readRoots: string[];
  private readonly contextOperations: MemoryContextOperations; private readonly searchProvider: SearchProvider;
  private readonly extraOperations: MemoryExtraOperations; private readonly threadOperations: ThreadOperations;
  private readonly noteOps: NoteOperations;

  constructor(
    private readonly adapter: FileSystemAdapter,
    private readonly config: MemoryConfig,
    options: MemoryManagerOptions = {},
  ) {
    this.writeRoot = path.resolve(config.basePath, config.engramRoot);
    this.readRoots = [this.writeRoot, ...config.readPaths.map((p) => path.resolve(config.basePath, p))];
    this.searchProvider = options.searchProvider ?? new KeywordSearchProvider();
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
      memoryDir: () => path.join(this.writeRoot, this.config.memoryPath),
      skillsDir: () => this.skillsDir(),
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
      ...(options.detectGitRemote === undefined ? {} : { detectGitRemote: options.detectGitRemote }),
      ...(options.detectPackageNames === undefined ? {} : { detectPackageNames: options.detectPackageNames }),
    });
    this.noteOps = new NoteOperations({
      adapter: this.adapter,
      assertWriteAllowed: (filePath) => { this.assertWriteAllowed(filePath); },
      notesDir: () => this.notesDir(),
      inboxDir: () => this.inboxDir(),
      normalizeNotePath: (filePath) => this.normalizeNotePath(filePath),
      noteRelativePath: (filePath) => this.noteRelativePath(filePath),
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
  };

  private memoryTypeDir(type: MemoryType | string): string {
    const dirName = MemoryManager.TYPE_DIRS[type] ?? type;
    return path.join(this.writeRoot, this.config.memoryPath, dirName);
  }

  private notesDir(): string { return path.join(this.writeRoot, this.config.notesPath); }

  private skillsDir(): string { return path.join(this.writeRoot, this.config.skillsPath); }

  private inboxDir(): string { return path.join(this.writeRoot, this.config.inboxPath); }

  private threadDir(): string { return path.join(this.writeRoot, this.config.threadsPath); }

  private threadPath(threadId: string): string { return path.join(this.threadDir(), `${threadId}.md`); }

  private contextLabelFor(note: VaultNote): string {
    const memoryRoot = path.join(this.writeRoot, this.config.memoryPath);
    return `memory:${path.relative(memoryRoot, note.path).replace(/\.md$/u, '')}`;
  }

  private conversationDir(dateStr?: string): string {
    return dateStr === undefined
      ? path.join(this.writeRoot, this.config.conversationsPath)
      : path.join(this.writeRoot, this.config.conversationsPath, dateStr);
  }

  private normalizeNotePath(filePath: string): string {
    // Route inbox/<subpath> to the top-level inbox directory.
    // Bare 'inbox' (no slash) falls through to notes — it creates notes/inbox.md,
    // which intentionally does NOT surface in inbox listings.
    if (!path.isAbsolute(filePath) && (filePath.startsWith('inbox/') || filePath.startsWith('inbox\\'))) {
      return this.normalizeInboxPath(filePath);
    }

    const notesRoot = this.notesDir();
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(notesRoot, filePath);
    const withExt = path.extname(resolved).length > 0 ? resolved : `${resolved}.md`;

    // Allow paths within either the notes or inbox directory
    const inboxRoot = this.inboxDir();
    if (withExt === notesRoot || withExt.startsWith(notesRoot + path.sep) ||
        withExt === inboxRoot || withExt.startsWith(inboxRoot + path.sep)) {
      return withExt;
    }

    throw new Error(
      `Note path must stay within the notes directory ("${notesRoot}")`,
    );
  }

  private normalizeInboxPath(filePath: string): string {
    const inboxRoot = this.inboxDir();
    // Strip the 'inbox/' prefix and resolve relative to the inbox directory
    const relativePath = filePath.replace(/^inbox[/\\]?/u, '');
    const resolved = relativePath.length > 0
      ? path.resolve(inboxRoot, relativePath)
      : inboxRoot;
    const withExt = path.extname(resolved).length > 0 ? resolved : `${resolved}.md`;

    if (withExt === inboxRoot || withExt.startsWith(inboxRoot + path.sep)) {
      return withExt;
    }

    throw new Error(
      `Inbox path must stay within the inbox directory ("${inboxRoot}")`,
    );
  }

  private noteRelativePath(filePath: string): string {
    const inboxRoot = this.inboxDir();
    if (filePath === inboxRoot || filePath.startsWith(inboxRoot + path.sep)) {
      return path.join('inbox', path.relative(inboxRoot, filePath));
    }
    return path.relative(this.notesDir(), filePath);
  }

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

  // ─── Thread operations (delegated to ThreadOperations) ────────────────────

  async getThread(threadId: string): Promise<VaultNote | null> { return await this.threadOperations.getThread(threadId); }
  async setThread(threadId: string, content: string, fields: ThreadFields = {}): Promise<VaultNote> { return await this.threadOperations.setThread(threadId, content, fields); }
  async updateThread(threadId: string, content?: string, fields?: ThreadFields): Promise<VaultNote> { return await this.threadOperations.updateThread(threadId, content, fields); }
  async listThreads(): Promise<VaultNote[]> { return await this.threadOperations.listThreads(); }
  async listThreadTodos(threadId: string, options: { includeCompleted?: boolean } = {}): Promise<Array<{ text: string; checked: boolean }>> { return await this.threadOperations.listThreadTodos(threadId, options); }
  async addThreadTodo(threadId: string, itemText: string, options: { prepend?: boolean } = {}): Promise<VaultNote> { return await this.threadOperations.addThreadTodo(threadId, itemText, options); }
  async completeThreadTodo(threadId: string, itemText: string): Promise<VaultNote> { return await this.threadOperations.completeThreadTodo(threadId, itemText); }
  async reopenThreadTodo(threadId: string, itemText: string): Promise<VaultNote> { return await this.threadOperations.reopenThreadTodo(threadId, itemText); }
  async removeThreadTodo(threadId: string, itemText: string): Promise<VaultNote> { return await this.threadOperations.removeThreadTodo(threadId, itemText); }
  async listThreadInbox(threadId: string): Promise<Array<{ path: string; content: string; created: string }>> { return await this.threadOperations.listThreadInbox(threadId); }
  async addThreadInboxItem(threadId: string, itemText: string): Promise<string> { return await this.threadOperations.addThreadInboxItem(threadId, itemText); }
  async completeThreadInboxItem(threadId: string, item: string): Promise<string> { return await this.threadOperations.completeThreadInboxItem(threadId, item); }
  async removeThreadInboxItem(threadId: string, item: string): Promise<string> { return await this.threadOperations.removeThreadInboxItem(threadId, item); }
  async getThreadInboxSummary(threadId: string): Promise<string | null> { return await this.threadOperations.getThreadInboxSummary(threadId); }
  async listGlobalInbox(): Promise<Array<{ path: string; content: string; created: string }>> { return await this.threadOperations.listGlobalInbox(); }
  async addGlobalInboxItem(content: string, name?: string): Promise<string> { return await this.threadOperations.addGlobalInboxItem(content, name); }
  async removeInboxItem(itemPath: string): Promise<string> { return await this.threadOperations.removeInboxItem(itemPath); }
  async getGlobalInboxSummary(activeThreadId?: string): Promise<string | null> { return await this.threadOperations.getGlobalInboxSummary(activeThreadId); }
  async resolveThread(hints: { cwd?: string; gitRemote?: string; autoCreate?: boolean }): Promise<ResolvedThread> { return await this.threadOperations.resolveThread(hints); }
  async mergeThreads(sourceId: string, targetId: string): Promise<{ retaggedCount: number }> { return await this.threadOperations.mergeThreads(sourceId, targetId); }

  // ─── Skill operations (delegated to MemoryExtraOperations) ────────────────

  async storeSkill(slug: string, content: string, tags: string[] = []): Promise<VaultNote> { return await this.extraOperations.storeSkill(slug, content, tags); }
  async getSkill(slug: string): Promise<VaultNote | null> { return await this.extraOperations.getSkill(slug); }
  async listSkills(): Promise<VaultNote[]> { return await this.extraOperations.listSkills(); }

  // ─── Note operations (delegated to NoteOperations) ────────────────────────

  async createNote(filePath: string, content: string): Promise<string> { return await this.noteOps.createNote(filePath, content); }
  async readNote(filePath: string): Promise<string> { return await this.noteOps.readNote(filePath); }
  async updateNote(filePath: string, content: string, expectedCurrentContent?: string): Promise<string> { return await this.noteOps.updateNote(filePath, content, expectedCurrentContent); }
  async appendNote(filePath: string, content: string, options: { expectedCurrentContent?: string; separator?: string } = {}): Promise<string> { return await this.noteOps.appendNote(filePath, content, options); }
  async listNotes(options: { limit?: number; prefix?: string } = {}): Promise<Array<{ path: string; preview: string }>> { return await this.noteOps.listNotes(options); }
  async searchNotes(query: string, options: { limit?: number } = {}): Promise<Array<{ path: string; preview: string; score?: number }>> { return await this.noteOps.searchNotes(query, options); }
  async deleteNote(filePath: string): Promise<string> { return await this.noteOps.deleteNote(filePath); }

  // ─── Scratch operations ───────────────────────────────────────────────────

  private get scratchFilePath(): string { return path.join(this.writeRoot, this.config.scratchFile); }

  async appendScratch(sessionId: string, content: string): Promise<void> {
    this.assertWriteAllowed(this.scratchFilePath);
    await appendScratchEntry(this.adapter, this.scratchFilePath, sessionId, content);
  }

  async readScratch(options: ScratchReadOptions = {}): Promise<ScratchEntry[]> {
    return await readScratchEntries(this.adapter, this.scratchFilePath, options, { bootstrapLimit: DEFAULT_BOOTSTRAP_LIMIT, defaultLimit: DEFAULT_SCRATCH_READ_LIMIT });
  }

  async readFirstPendingDream(): Promise<PendingDream | null> {
    const entries = await readAllScratchEntries(this.adapter, this.scratchFilePath);
    return extractFirstPendingDream(entries);
  }

  async compactScratch(options: ScratchCompactOptions): Promise<void> { this.assertWriteAllowed(this.scratchFilePath); await compactScratchFile(this.adapter, this.scratchFilePath, options); }
  async pruneScratch(options: ScratchPruneOptions): Promise<number> { this.assertWriteAllowed(this.scratchFilePath); return await pruneScratchFile(this.adapter, this.scratchFilePath, options); }
  async deleteScratch(options: ScratchDeleteOptions): Promise<number> { this.assertWriteAllowed(this.scratchFilePath); return await deleteScratchFile(this.adapter, this.scratchFilePath, options); }
  async sweepScratch(): Promise<number> { this.assertWriteAllowed(this.scratchFilePath); return await sweepScratchFile(this.adapter, this.scratchFilePath); }
  async clearScratch(): Promise<void> { this.assertWriteAllowed(this.scratchFilePath); await this.adapter.delete(this.scratchFilePath).catch(() => undefined); }

  // ─── Archive & conversation (delegated to MemoryExtraOperations) ──────────

  async archiveForgotten(olderThanDays?: number): Promise<string[]> { return await this.extraOperations.archiveForgotten(olderThanDays); }
  async saveConversation(conversation: Conversation, slug?: string): Promise<VaultNote> { return await this.extraOperations.saveConversation(conversation, slug); }
  async storeConversation(messages: Array<Pick<Message, 'role' | 'content'>>, summary?: string, tags?: string[], slug?: string): Promise<VaultNote> { return await this.extraOperations.storeConversation(messages, summary, tags ?? [], slug); }
}
