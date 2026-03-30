import * as os from 'os';
import * as path from 'path';

/** Expand a leading `~` to the current user's home directory. */
function expandHome(p: string): string {
  return p.startsWith('~') ? os.homedir() + p.slice(1) : p;
}
import type { FileSystemAdapter } from './adapters/types';
import {
  MemoryState,
  MemoryType,
  ThreadStatus,
  SOUL_DOCUMENT_SLUG,
} from './types';
import type {
  MemoryConfig,
  MemoryFilters,
  ContextSection,
  TokenBudget,
  NoteFrontmatter,
  ThreadFrontmatter,
  ThreadFields,
  Confidence,
  ScratchEntry,
  ScratchReadOptions,
  ScratchCompactOptions,
} from './types';
import { VaultNote } from './vault';
import { slugify, datePath } from './utils';
import { ContextBuilder } from './context';
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
    [MemoryType.Skill]: 'skills',
  };

  private memoryTypeDir(type: MemoryType | string): string {
    const dirName = MemoryManager.TYPE_DIRS[type] ?? type;
    return path.join(this.writeRoot, this.config.memoryPath, dirName);
  }

  private threadDir(): string {
    return path.join(this.writeRoot, this.config.threadsPath);
  }

  private threadPath(threadId: string): string {
    return path.join(this.threadDir(), `${threadId}.md`);
  }

  private conversationDir(dateStr?: string): string {
    const base = path.join(this.writeRoot, this.config.conversationsPath);
    return dateStr ? path.join(base, dateStr) : base;
  }

  private workingDir(): string {
    return path.join(this.writeRoot, this.config.workingPath);
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
   *  - Core memories (always in context, priority 90)
   *  - Remembered memories (always in context, priority 70)
   *  - Relevant default-state memories from a keyword search (priority 50)
   *
   * The Soul document is intentionally excluded — load it separately via
   * getSoulDocument() / soul_get so harnesses that inject it at the
   * system-prompt level don't receive a duplicate copy here.
   */
  async getContext(query: string, budget: TokenBudget, threadId?: string): Promise<ContextSection[]> {
    const dir = path.join(this.writeRoot, this.config.memoryPath);
    const allFiles = await this.adapter.list(dir);

    const allNotes = await Promise.all(
      allFiles.map((f) => VaultNote.read(this.adapter, f).catch(() => null)),
    );
    const valid = allNotes.filter((n): n is VaultNote => n !== null);

    const soulPath = path.join(this.memoryTypeDir(MemoryType.Reflection), `${SOUL_DOCUMENT_SLUG}.md`);

    // Core memories always load regardless of thread — core is core.
    const coreNotes = valid.filter(
      (n) => n.frontmatter.memory_state === MemoryState.Core && n.path !== soulPath,
    );

    // Remembered: load if unthreaded (cross-thread) or matching active thread.
    // Exclude remembered memories tagged to a different thread.
    const rememberedNotes = valid.filter((n) => {
      if (n.frontmatter.memory_state !== MemoryState.Remembered) return false;
      if (!threadId) return true;
      const noteThread = n.frontmatter.thread as string | undefined;
      return !noteThread || noteThread === threadId;
    });

    // Default: search-relevant, unthreaded or matching active thread.
    const searchResults = await this.search(query);
    const relevantNotes = searchResults.filter((n) => {
      if (
        n.frontmatter.memory_state === MemoryState.Forgotten ||
        n.frontmatter.memory_state === MemoryState.Core ||
        n.frontmatter.memory_state === MemoryState.Remembered
      ) return false;
      if (!threadId) return true;
      const noteThread = n.frontmatter.thread as string | undefined;
      return !noteThread || noteThread === threadId;
    });

    const builder = new ContextBuilder();

    for (const n of coreNotes) {
      builder.addSection(`memory:${n.path}`, n.content, 90);
    }
    for (const n of rememberedNotes) {
      const body = n.frontmatter.summary as string | undefined ?? n.content;
      builder.addSection(`memory:${n.path}`, body, 70);
    }
    for (const n of relevantNotes) {
      const body = n.frontmatter.summary as string | undefined ?? n.content;
      builder.addSection(`memory:${n.path}`, body, 50);
    }

    return builder.selectSections(budget.max);
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

  // ─── Thread operations ────────────────────────────────────────────────────

  /**
   * Get a thread document by ID. Returns null if not found.
   */
  async getThread(threadId: string): Promise<VaultNote | null> {
    return VaultNote.read(this.adapter, this.threadPath(threadId)).catch(() => null);
  }

  /**
   * Create or overwrite a thread document.
   * Stored at engram/threads/{threadId}.md.
   */
  async setThread(
    threadId: string,
    content: string,
    fields: ThreadFields = {},
  ): Promise<VaultNote> {
    const dir = this.threadDir();
    const filePath = this.threadPath(threadId);

    this.assertWriteAllowed(filePath);
    await this.adapter.mkdir(dir);

    const existing = await VaultNote.read(this.adapter, filePath).catch(() => null);
    const now = new Date().toISOString();

    const frontmatter: ThreadFrontmatter = {
      type: 'thread',
      thread_id: threadId,
      name: fields.name ?? threadId,
      status: fields.status ?? ThreadStatus.Active,
      created: existing?.frontmatter.created as string ?? now,
      updated: now,
      tags: fields.tags ?? [`engram/thread`, `engram/thread/${threadId}`],
    };
    if (fields.description !== undefined) frontmatter.description = fields.description;
    if (fields.goals !== undefined) frontmatter.goals = fields.goals;
    if (fields.paths !== undefined) frontmatter.paths = fields.paths;
    if (fields.related_threads !== undefined) frontmatter.related_threads = fields.related_threads;

    return VaultNote.create(this.adapter, filePath, frontmatter as unknown as NoteFrontmatter, content);
  }

  /**
   * Update an existing thread document's content and/or frontmatter fields.
   */
  async updateThread(
    threadId: string,
    content?: string,
    fields?: ThreadFields,
  ): Promise<VaultNote> {
    const filePath = this.threadPath(threadId);
    this.assertWriteAllowed(filePath);

    const note = await VaultNote.read(this.adapter, filePath);

    if (content !== undefined) {
      note.content = content;
    }
    if (fields) {
      const updates: Record<string, unknown> = { updated: new Date().toISOString() };
      if (fields.name !== undefined) updates.name = fields.name;
      if (fields.description !== undefined) updates.description = fields.description;
      if (fields.status !== undefined) updates.status = fields.status;
      if (fields.goals !== undefined) updates.goals = fields.goals;
      if (fields.paths !== undefined) updates.paths = fields.paths;
      if (fields.related_threads !== undefined) updates.related_threads = fields.related_threads;
      if (fields.tags !== undefined) updates.tags = fields.tags;
      note.updateFrontmatter(updates as Partial<NoteFrontmatter>);
    }

    await note.save(this.adapter);
    return note;
  }

  /**
   * List all thread documents.
   */
  async listThreads(): Promise<VaultNote[]> {
    const dir = this.threadDir();
    const files = await this.adapter.list(dir).catch(() => [] as string[]);
    const notes = await Promise.all(
      files.map((f) => VaultNote.read(this.adapter, f).catch(() => null)),
    );
    return notes.filter((n): n is VaultNote => n !== null);
  }

  /**
   * Resolve the active Thread from environment context.
   *
   * Matching: lists all threads with `paths` set and checks whether `cwd` is
   * inside a thread's path (or vice versa) using prefix matching. Prefers
   * active threads over paused/closed; breaks ties by longest matching path
   * (most specific wins).
   *
   * If no match is found and `autoCreate` is true (default), creates a minimal
   * thread named after `path.basename(cwd)` with `paths: [cwd]`.
   *
   * Returns the resolved thread ID, whether it was freshly created, and the
   * full VaultNote.
   */
  async resolveThread(hints: {
    cwd?: string;
    gitRemote?: string;
    autoCreate?: boolean;
  }): Promise<{ threadId: string; created: boolean; thread: VaultNote }> {
    const cwd = path.resolve(expandHome(hints.cwd ?? process.cwd()));
    const autoCreate = hints.autoCreate ?? true;

    const threads = await this.listThreads();

    const statusRank = (status: unknown): number => {
      if (status === ThreadStatus.Active) return 2;
      if (status === ThreadStatus.Paused) return 1;
      return 0;
    };

    let bestThread: VaultNote | null = null;
    let bestScore = -1;
    let bestStatusRank = -1;

    for (const thread of threads) {
      const rank = statusRank(thread.frontmatter.status);

      // Primary signal: path prefix match.
      const paths = thread.frontmatter.paths as string[] | undefined;
      if (paths && paths.length > 0) {
        for (const threadPath of paths) {
          const resolved = path.resolve(expandHome(threadPath));
          const cwdInThread = cwd === resolved || cwd.startsWith(resolved + path.sep);
          const threadInCwd = resolved === cwd || resolved.startsWith(cwd + path.sep);
          if (!cwdInThread && !threadInCwd) continue;

          // Score by the length of the more specific (longer) path — longer = tighter match.
          const overlapScore = cwdInThread ? resolved.length : cwd.length;

          if (
            bestThread === null ||
            rank > bestStatusRank ||
            (rank === bestStatusRank && overlapScore > bestScore)
          ) {
            bestThread = thread;
            bestScore = overlapScore;
            bestStatusRank = rank;
          }
        }
      }

      // Secondary signal: git remote URL match (only promotes if no path match yet or same rank).
      if (hints.gitRemote) {
        const repos = thread.frontmatter.repositories as string[] | undefined;
        if (repos && repos.some((r) => r === hints.gitRemote)) {
          // Remote match scores lower than any path match (score = 0).
          if (
            bestThread === null ||
            rank > bestStatusRank ||
            (rank === bestStatusRank && bestScore < 0)
          ) {
            bestThread = thread;
            bestScore = 0;
            bestStatusRank = rank;
          }
        }
      }
    }

    if (bestThread) {
      return {
        threadId: bestThread.frontmatter.thread_id as string,
        created: false,
        thread: bestThread,
      };
    }

    if (!autoCreate) {
      throw new Error(`No matching thread found for cwd: ${cwd}`);
    }

    // Auto-create a minimal thread from the directory name.
    const threadId = slugify(path.basename(cwd));
    const thread = await this.setThread(threadId, '', {
      name: path.basename(cwd),
      paths: [cwd],
    });

    return { threadId, created: true, thread };
  }

  /**
   * Merge a source Thread into a target Thread.
   *
   * - Re-tags all memories with `thread: sourceId` to `thread: targetId`.
   * - Unions `paths`, `goals`, and `related_threads` from source into target.
   * - Closes the source thread with a body note pointing to the target.
   *
   * Returns the count of memories that were re-tagged.
   */
  async mergeThreads(
    sourceId: string,
    targetId: string,
  ): Promise<{ retaggedCount: number }> {
    const source = await this.getThread(sourceId);
    if (!source) throw new Error(`Source thread not found: ${sourceId}`);
    const target = await this.getThread(targetId);
    if (!target) throw new Error(`Target thread not found: ${targetId}`);

    // Re-tag all memories belonging to the source thread.
    const sourceMemos = await this.list({ thread: sourceId });
    await Promise.all(
      sourceMemos.map((note) =>
        this.update(note.path, undefined, { thread: targetId }),
      ),
    );

    // Union metadata fields.
    const sourcePaths = (source.frontmatter.paths as string[] | undefined) ?? [];
    const targetPaths = (target.frontmatter.paths as string[] | undefined) ?? [];
    const mergedPaths = [...new Set([...targetPaths, ...sourcePaths])];

    const sourceGoals = (source.frontmatter.goals as string[] | undefined) ?? [];
    const targetGoals = (target.frontmatter.goals as string[] | undefined) ?? [];
    const mergedGoals = [...new Set([...targetGoals, ...sourceGoals])];

    const sourceRelated = (source.frontmatter.related_threads as string[] | undefined) ?? [];
    const targetRelated = (target.frontmatter.related_threads as string[] | undefined) ?? [];
    const mergedRelated = [
      ...new Set(
        [...targetRelated, ...sourceRelated].filter(
          (id) => id !== sourceId && id !== targetId,
        ),
      ),
    ];

    const targetDesc = (target.frontmatter.description as string | undefined) ?? '';
    const sourceDesc = (source.frontmatter.description as string | undefined) ?? '';
    const mergedDesc =
      targetDesc && sourceDesc
        ? `${targetDesc}\n\nMerged from ${sourceId}: ${sourceDesc}`
        : targetDesc || sourceDesc || undefined;

    await this.updateThread(targetId, undefined, {
      paths: mergedPaths.length > 0 ? mergedPaths : undefined,
      goals: mergedGoals.length > 0 ? mergedGoals : undefined,
      related_threads: mergedRelated.length > 0 ? mergedRelated : undefined,
      description: mergedDesc,
    });

    // Close the source thread.
    const date = new Date().toISOString().slice(0, 10);
    await this.updateThread(
      sourceId,
      `Merged into [[${targetId}]] on ${date}. All memories re-tagged to target thread.`,
      { status: ThreadStatus.Closed },
    );

    return { retaggedCount: sourceMemos.length };
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

  private get scratchFilePath(): string {
    return path.join(this.writeRoot, this.config.scratchFile);
  }

  private parseScratchLog(raw: string): ScratchEntry[] {
    const entryPattern = /^\[([^\]]+) \| ([^\]]+)\] (.+)$/;
    return raw
      .split('\n')
      .map((line) => {
        const match = line.match(entryPattern);
        if (!match) return null;
        return { sessionId: match[1], timestamp: match[2], content: match[3] };
      })
      .filter((e): e is ScratchEntry => e !== null);
  }

  /**
   * Append an entry to the shared scratch log.
   * Each entry is prefixed with the session ID and an ISO timestamp.
   * Newlines in content are collapsed to keep entries single-line.
   */
  async appendScratch(sessionId: string, content: string): Promise<void> {
    const logPath = this.scratchFilePath;
    this.assertWriteAllowed(logPath);

    const timestamp = new Date().toISOString();
    const line = `[${sessionId} | ${timestamp}] ${content.replace(/\n+/g, ' | ')}`;

    const existing = await this.adapter.read(logPath).catch(() => '');
    const newContent = existing.trim() ? `${existing.trimEnd()}\n${line}` : line;
    await this.adapter.write(logPath, newContent);
  }

  /**
   * Read scratch log entries, with optional filtering and pagination.
   * Returns entries sorted oldest-first. Applies limit after filtering.
   */
  async readScratch(options: ScratchReadOptions = {}): Promise<ScratchEntry[]> {
    const raw = await this.adapter.read(this.scratchFilePath).catch(() => '');
    if (!raw.trim()) return [];

    let entries = this.parseScratchLog(raw);

    if (options.sessionId) {
      entries = entries.filter((e) => e.sessionId === options.sessionId);
    }
    if (options.since) {
      const sinceTs = new Date(options.since).getTime();
      entries = entries.filter((e) => new Date(e.timestamp).getTime() >= sinceTs);
    }

    // Sort descending to apply limit, then restore ascending for readability
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const limit = options.limit ?? 50;
    entries = entries.slice(0, limit);
    entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return entries;
  }

  /**
   * Compact scratch entries for a session. Finds entries for the given session
   * older than thresholdMs, removes them, and inserts a single replacement entry
   * containing the agent-provided synthesized content.
   */
  async compactScratch(options: ScratchCompactOptions): Promise<void> {
    const logPath = this.scratchFilePath;
    this.assertWriteAllowed(logPath);

    const raw = await this.adapter.read(logPath).catch(() => '');
    if (!raw.trim()) return;

    const lines = raw.split('\n');
    const entryPattern = /^\[([^\]]+) \| ([^\]]+)\] (.+)$/;
    const cutoff = Date.now() - options.thresholdMs;

    const toRemove = new Set<number>();
    let firstIdx = -1;

    lines.forEach((line, idx) => {
      const match = line.match(entryPattern);
      if (!match || match[1] !== options.sessionId) return;
      if (new Date(match[2]).getTime() > cutoff) return;
      toRemove.add(idx);
      if (firstIdx === -1) firstIdx = idx;
    });

    if (toRemove.size < 2) return; // Nothing worth compacting

    const compactLine = `[${options.sessionId} | ${new Date().toISOString()}] [COMPACTED] ${options.compactedContent.replace(/\n+/g, ' | ')}`;

    const newLines = lines
      .map((line, idx) => {
        if (idx === firstIdx) return compactLine;
        if (toRemove.has(idx)) return null;
        return line;
      })
      .filter((line): line is string => line !== null);

    await this.adapter.write(logPath, newLines.join('\n'));
  }

  /**
   * Hard-delete the scratch log.
   * Scratch is explicitly ephemeral — deletion is permanent with no archiving.
   */
  async clearScratch(): Promise<void> {
    const logPath = this.scratchFilePath;
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
    if (filters.bootstrap_state !== undefined) {
      result = result.filter((n) => n.frontmatter.bootstrap_state === filters.bootstrap_state);
    }
    if (filters.agent !== undefined) {
      result = result.filter((n) => n.frontmatter.agent === filters.agent);
    }
    if (filters.platform !== undefined) {
      result = result.filter((n) => n.frontmatter.platform === filters.platform);
    }
    if (filters.thread !== undefined) {
      result = result.filter((n) => n.frontmatter.thread === filters.thread);
    }
    if (filters.limit !== undefined) {
      result = result.slice(0, filters.limit);
    }

    return result;
  }
}
