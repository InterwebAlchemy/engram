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

  private memoryTypeDir(type: MemoryType | string): string {
    return path.join(this.writeRoot, this.config.memoryPath, type);
  }

  private conversationDir(dateStr?: string): string {
    const base = path.join(this.writeRoot, this.config.conversationsPath);
    return dateStr ? path.join(base, dateStr) : base;
  }

  private workingDir(): string {
    return path.join(this.writeRoot, this.config.workingPath);
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
    const target = path.resolve(filePath);
    const allowed = this.readRoots.some(
      (root) => target === root || target.startsWith(root + path.sep),
    );

    if (!allowed) {
      throw new Error(
        `Read denied: "${filePath}" is outside configured read paths`,
      );
    }

    return VaultNote.read(this.adapter, filePath);
  }

  /**
   * Update an existing memory note's content and/or frontmatter.
   */
  async update(
    filePath: string,
    content?: string,
    frontmatterUpdates?: Partial<NoteFrontmatter>,
  ): Promise<VaultNote> {
    this.assertWriteAllowed(filePath);

    const note = await VaultNote.read(this.adapter, filePath);

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
