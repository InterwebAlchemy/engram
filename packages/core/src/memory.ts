import * as path from 'path';
import type { FileSystemAdapter } from './adapters/types';
import {
  MemoryState,
  MemoryType,
  SOUL_DOCUMENT_SLUG,
} from './types';
import type {
  MemoryConfig,
  MemoryFilters,
  ContextSection,
  TokenBudget,
  NoteFrontmatter,
  Confidence,
} from './types';
import { VaultNote } from './vault';
import { slugify, datePath } from './utils';
import { Conversation } from './conversation';
import type { ConversationFrontmatter, Message } from './types';

export class MemoryManager {
  /** Absolute path to the engram write root. */
  private readonly writeRoot: string;
  /** Absolute paths the assistant may read. */
  private readonly readRoots: string[];

  constructor(
    private readonly adapter: FileSystemAdapter,
    private readonly config: MemoryConfig,
  ) {
    this.writeRoot = path.resolve(config.basePath, config.engramRoot);
    this.readRoots = [
      this.writeRoot,
      ...config.readPaths.map((p) => path.resolve(config.basePath, p)),
    ];
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
    return path.extname(resolved) ? resolved : `${resolved}.md`;
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

  private conversationDir(dateStr?: string): string {
    const base = path.join(this.writeRoot, this.config.conversationsPath);
    return dateStr ? path.join(base, dateStr) : base;
  }

  private workingDir(): string {
    return path.join(this.writeRoot, this.config.workingPath);
  }

  private scratchDir(): string {
    return path.join(this.writeRoot, this.config.scratchPath);
  }

  private archiveDir(): string {
    return path.join(this.writeRoot, this.config.archivePath);
  }

  // ─── Core memory operations ───────────────────────────────────────────────

  /**
   * Store a new memory note in the vault.
   * The note is created under engram/<memoryPath>/<type>/<slug>.md.
   */
  async store(
    content: string,
    type: MemoryType,
    tags: string[] = [],
    provider?: string,
    confidence?: Confidence,
  ): Promise<VaultNote> {
    const now = new Date();
    const slug = slugify(content.slice(0, 60));
    const dir = this.memoryTypeDir(type);
    const filePath = path.join(dir, `${slug}.md`);

    this.assertWriteAllowed(filePath);
    await this.adapter.mkdir(dir);

    const frontmatter: NoteFrontmatter = {
      type,
      created: now.toISOString(),
      updated: now.toISOString(),
      tags,
      memory_state: MemoryState.Default,
      ...(provider ? { provider } : {}),
      ...(confidence ? { confidence } : {}),
    };

    return VaultNote.create(this.adapter, filePath, frontmatter, content);
  }

  /**
   * Search memories by keyword query with optional frontmatter filters.
   */
  async search(query: string, filters?: MemoryFilters): Promise<VaultNote[]> {
    const dir = path.join(this.writeRoot, this.config.memoryPath);
    const results = await this.adapter.search(query, dir);

    const notes = await Promise.all(
      results.map((r) => VaultNote.read(this.adapter, r.path).catch(() => null)),
    );

    return this.applyFilters(
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

    return VaultNote.read(this.adapter, target);
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
    if (frontmatterUpdates) {
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
      files.map((f) => VaultNote.read(this.adapter, f).catch(() => null)),
    );

    return this.applyFilters(
      notes.filter((n): n is VaultNote => n !== null),
      filters,
    );
  }

  /**
   * Build context sections for prompt assembly:
   *  - Soul document (always first, priority 100)
   *  - Core memories (always in context, priority 90)
   *  - Relevant memories from a keyword search (priority 50)
   */
  async getContext(query: string, _budget: TokenBudget): Promise<ContextSection[]> {
    const dir = path.join(this.writeRoot, this.config.memoryPath);
    const allFiles = await this.adapter.list(dir);

    const allNotes = await Promise.all(
      allFiles.map((f) => VaultNote.read(this.adapter, f).catch(() => null)),
    );
    const valid = allNotes.filter((n): n is VaultNote => n !== null);

    const soulPath = path.join(this.memoryTypeDir(MemoryType.Reflection), `${SOUL_DOCUMENT_SLUG}.md`);
    const coreNotes = valid.filter(
      (n) => n.frontmatter.memory_state === MemoryState.Core && n.path !== soulPath,
    );

    const searchResults = await this.search(query);
    const relevantNotes = searchResults.filter(
      (n) =>
        n.frontmatter.memory_state !== MemoryState.Forgotten &&
        n.frontmatter.memory_state !== MemoryState.Core,
    );

    const seen = new Set<string>();
    const sections: ContextSection[] = [];

    // Soul document is always loaded first, before all other Core memories
    const soulNote = valid.find((n) => n.path === soulPath);
    if (soulNote) {
      seen.add(soulNote.path);
      sections.push({ label: 'soul-document', content: soulNote.content, priority: 100 });
    }

    for (const n of coreNotes) {
      if (!seen.has(n.path)) {
        seen.add(n.path);
        sections.push({ label: `memory:${n.path}`, content: n.content, priority: 90 });
      }
    }
    for (const n of relevantNotes) {
      if (!seen.has(n.path)) {
        seen.add(n.path);
        sections.push({ label: `memory:${n.path}`, content: n.content, priority: 50 });
      }
    }

    return sections;
  }

  /**
   * Read the soul document, or return null if it doesn't exist yet.
   */
  async getSoulDocument(): Promise<VaultNote | null> {
    const filePath = path.join(this.memoryTypeDir(MemoryType.Reflection), `${SOUL_DOCUMENT_SLUG}.md`);
    return VaultNote.read(this.adapter, filePath).catch(() => null);
  }

  /**
   * Write (or overwrite) the soul document.
   * Always stored at engram/memory/reflection/soul.md with type=reflection
   * and memory_state=core.
   */
  async setSoulDocument(content: string): Promise<VaultNote> {
    const dir = this.memoryTypeDir(MemoryType.Reflection);
    const filePath = path.join(dir, `${SOUL_DOCUMENT_SLUG}.md`);

    this.assertWriteAllowed(filePath);
    await this.adapter.mkdir(dir);

    const existing = await VaultNote.read(this.adapter, filePath).catch(() => null);
    const now = new Date().toISOString();

    const frontmatter: NoteFrontmatter = {
      type: MemoryType.Reflection,
      created: existing?.frontmatter.created ?? now,
      updated: now,
      memory_state: MemoryState.Core,
      tags: ['soul-document'],
    };

    return VaultNote.create(this.adapter, filePath, frontmatter, content);
  }

  // ─── Skill operations ─────────────────────────────────────────────────────

  /**
   * Store or overwrite a skill by slug.
   * Skills live at engram/memory/skill/{slug}.md and default to Core state
   * so they are always available for retrieval but loaded on demand, not
   * auto-injected like soul.
   */
  async storeSkill(slug: string, content: string, tags: string[] = []): Promise<VaultNote> {
    const dir = this.memoryTypeDir(MemoryType.Skill);
    const filePath = path.join(dir, `${slug}.md`);

    this.assertWriteAllowed(filePath);
    await this.adapter.mkdir(dir);

    const existing = await VaultNote.read(this.adapter, filePath).catch(() => null);
    const now = new Date().toISOString();

    const frontmatter: NoteFrontmatter = {
      type: MemoryType.Skill,
      created: existing?.frontmatter.created ?? now,
      updated: now,
      memory_state: MemoryState.Core,
      tags,
    };

    return VaultNote.create(this.adapter, filePath, frontmatter, content);
  }

  /**
   * Retrieve a skill by slug. Returns null if not found.
   */
  async getSkill(slug: string): Promise<VaultNote | null> {
    const filePath = path.join(this.memoryTypeDir(MemoryType.Skill), `${slug}.md`);
    return VaultNote.read(this.adapter, filePath).catch(() => null);
  }

  /**
   * List all stored skills.
   */
  async listSkills(): Promise<VaultNote[]> {
    const dir = this.memoryTypeDir(MemoryType.Skill);
    const files = await this.adapter.list(dir).catch(() => [] as string[]);
    const notes = await Promise.all(
      files.map((f) => VaultNote.read(this.adapter, f).catch(() => null)),
    );
    return notes.filter((n): n is VaultNote => n !== null);
  }

  // ─── Scratch operations ───────────────────────────────────────────────────

  /**
   * Write (or overwrite) a scratch note by key.
   * Scratch notes live at engram/scratch/{key}.md and are never injected
   * into context — they exist solely as an assistant workspace.
   */
  async writeScratch(key: string, content: string): Promise<VaultNote> {
    const dir = this.scratchDir();
    const filePath = path.join(dir, `${key}.md`);

    this.assertWriteAllowed(filePath);
    await this.adapter.mkdir(dir);

    const existing = await VaultNote.read(this.adapter, filePath).catch(() => null);
    const now = new Date().toISOString();

    const frontmatter: NoteFrontmatter = {
      type: MemoryType.Scratch,
      created: existing?.frontmatter.created ?? now,
      updated: now,
      memory_state: MemoryState.Forgotten,
    };

    return VaultNote.create(this.adapter, filePath, frontmatter, content);
  }

  /**
   * Read a scratch note by key. Returns null if not found.
   */
  async readScratch(key: string): Promise<VaultNote | null> {
    const filePath = path.join(this.scratchDir(), `${key}.md`);
    return VaultNote.read(this.adapter, filePath).catch(() => null);
  }

  /**
   * List all current scratch keys (filenames without extension).
   */
  async listScratch(): Promise<string[]> {
    const dir = this.scratchDir();
    const files = await this.adapter.list(dir).catch(() => [] as string[]);
    return files.map((f) => path.basename(f, '.md'));
  }

  /**
   * Hard-delete scratch notes. If a key is provided, only that note is deleted.
   * If no key is provided, all scratch notes are deleted.
   * Scratch is explicitly ephemeral — deletion is permanent with no archiving.
   */
  async clearScratch(key?: string): Promise<void> {
    const dir = this.scratchDir();
    const targets = key
      ? [path.join(dir, `${key}.md`)]
      : (await this.adapter.list(dir).catch(() => [] as string[]));

    await Promise.all(
      targets.map(async (filePath) => {
        this.assertWriteAllowed(filePath);
        await this.adapter.delete(filePath);
      }),
    );
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
    const forgotten = await this.list({ state: MemoryState.Forgotten });

    const cutoff = olderThanDays !== undefined
      ? new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000)
      : null;

    const toArchive = cutoff
      ? forgotten.filter((n) => new Date(n.frontmatter.updated as string) <= cutoff)
      : forgotten;

    const archived: string[] = [];

    await Promise.all(
      toArchive.map(async (note) => {
        // Derive archive path by replacing the writeRoot prefix with archiveDir
        const relative = path.relative(this.writeRoot, note.path);
        const dest = path.join(this.archiveDir(), relative);

        this.assertWriteAllowed(note.path);
        await this.adapter.mkdir(path.dirname(dest));
        await this.adapter.write(dest, note.serialize());
        await this.adapter.delete(note.path);
        archived.push(dest);
      }),
    );

    return archived;
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
    const date = datePath(new Date(conversation.frontmatter.created));
    const fileSlug = slug ?? `conversation-${Date.now()}`;
    const dir = this.conversationDir(date);
    const filePath = path.join(dir, `${fileSlug}.md`);

    this.assertWriteAllowed(filePath);
    await this.adapter.mkdir(dir);

    const content = conversation.toMarkdown();
    await this.adapter.write(filePath, content);

    return VaultNote.read(this.adapter, filePath);
  }

  /**
   * Create and save a conversation from a raw messages array.
   */
  async storeConversation(
    messages: Pick<Message, 'role' | 'content'>[],
    summary?: string,
    tags: string[] = [],
    slug?: string,
  ): Promise<VaultNote> {
    const now = new Date().toISOString();
    const providers: string[] = [];

    const fullMessages: Message[] = messages.map((m) => ({
      role: m.role,
      content: m.content,
      timestamp: new Date(),
      memoryState: MemoryState.Default,
    }));

    const frontmatter: ConversationFrontmatter = {
      type: 'conversation',
      created: now,
      updated: now,
      providers,
      tags,
      summary,
      message_count: fullMessages.length,
    };

    const conversation = new Conversation(fullMessages, frontmatter);
    const fileSlug = slug ?? (summary ? slugify(summary) : undefined);
    return this.saveConversation(conversation, fileSlug);
  }

  // ─── Filter helpers ───────────────────────────────────────────────────────

  private applyFilters(notes: VaultNote[], filters?: MemoryFilters): VaultNote[] {
    if (!filters) return notes;

    let result = notes;

    if (filters.type !== undefined) {
      result = result.filter((n) => n.frontmatter.type === filters.type);
    }
    if (filters.state !== undefined) {
      result = result.filter((n) => n.frontmatter.memory_state === filters.state);
    }
    if (filters.tags && filters.tags.length > 0) {
      result = result.filter((n) => {
        const noteTags = (n.frontmatter.tags as string[] | undefined) ?? [];
        return filters.tags!.some((t) => noteTags.includes(t));
      });
    }
    if (filters.since !== undefined) {
      const since = filters.since;
      result = result.filter(
        (n) => new Date(n.frontmatter.created as string) >= since,
      );
    }
    if (filters.limit !== undefined) {
      result = result.slice(0, filters.limit);
    }

    return result;
  }
}
