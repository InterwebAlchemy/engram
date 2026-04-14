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
  ScratchPruneOptions,
} from './types';
import { VaultNote } from './vault';
import { slugify, datePath } from './utils';
import { ContextBuilder } from './context';
import { Conversation } from './conversation';
import type { ConversationFrontmatter, Message } from './types';
import { KeywordSearchProvider } from './scoring';
import type { SearchProvider } from './scoring';

type ProcessCapableAdapter = FileSystemAdapter & {
  process(path: string, fn: (content: string) => string): Promise<string>;
};

function supportsProcess(adapter: FileSystemAdapter): adapter is ProcessCapableAdapter {
  return typeof (adapter as ProcessCapableAdapter).process === 'function';
}

/** Return summary for non-core context loading, or null when unavailable. */
function summaryOnly(note: VaultNote): string | null {
  const summary = note.frontmatter.summary;
  return typeof summary === 'string' && summary.trim().length > 0
    ? summary
    : null;
}

function normalizeNoteContent(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}


function truncateInline(text: string, maxChars: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

type ChecklistSectionMatch = {
  headingIndex: number;
  bodyStartIndex: number;
  endIndex: number;
};

type ChecklistItem = {
  text: string;
  checked: boolean;
  lineIndex: number;
};

const ANY_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+\S/;
const CHECKLIST_ITEM_PATTERN = /^\s*(?:[-*]|\d+\.)\s+\[([ xX])\]\s+(.+?)\s*$/;
const TODO_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+todos?\s*$/i;
const INBOX_HEADING_PATTERN = /^\s{0,3}#{1,6}\s+inbox\s*$/i;

function normalizeChecklistText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function findChecklistSection(
  lines: string[],
  headingPattern: RegExp,
): ChecklistSectionMatch | null {
  for (let index = 0; index < lines.length; index += 1) {
    if (!headingPattern.test(lines[index] ?? '')) continue;

    let endIndex = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (ANY_HEADING_PATTERN.test(lines[cursor] ?? '')) {
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

function extractChecklistItems(
  content: string,
  headingPattern: RegExp,
  options: {
    includeCompleted?: boolean;
    limit?: number;
  } = {},
): ChecklistItem[] {
  const lines = normalizeNoteContent(content).split('\n');
  const section = findChecklistSection(lines, headingPattern);
  if (!section) return [];

  const items: ChecklistItem[] = [];
  for (let index = section.bodyStartIndex; index < section.endIndex; index += 1) {
    const match = lines[index]?.match(CHECKLIST_ITEM_PATTERN);
    if (!match) continue;
    const checked = match[1].toLowerCase() === 'x';
    if (checked && !options.includeCompleted) continue;

    items.push({
      text: normalizeChecklistText(match[2]),
      checked,
      lineIndex: index,
    });
    if (items.length >= (options.limit ?? Number.POSITIVE_INFINITY)) break;
  }

  return items;
}

function summarizeChecklist(
  label: string,
  items: ChecklistItem[],
): string | null {
  if (items.length === 0) return null;
  return [
    `${label}:`,
    ...items.map((item) => `- [ ] ${truncateInline(item.text, 120)}`),
  ].join('\n');
}

function ensureChecklistSection(
  lines: string[],
  heading: string,
  headingPattern: RegExp,
): ChecklistSectionMatch {
  const existing = findChecklistSection(lines, headingPattern);
  if (existing) return existing;

  if (lines.length === 1 && lines[0] === '') {
    lines.splice(0, 1);
  }

  if (lines.length > 0 && lines[lines.length - 1]?.trim() !== '') {
    lines.push('');
  }

  lines.push(`## ${heading}`);
  return {
    headingIndex: lines.length - 1,
    bodyStartIndex: lines.length,
    endIndex: lines.length,
  };
}

function addChecklistItem(
  content: string,
  heading: string,
  headingPattern: RegExp,
  itemText: string,
  options: { prepend?: boolean } = {},
): string {
  const normalizedContent = normalizeNoteContent(content);
  const lines = normalizedContent ? normalizedContent.split('\n') : [''];
  const normalizedTarget = normalizeChecklistText(itemText);
  const section = ensureChecklistSection(lines, heading, headingPattern);
  const matches = extractChecklistItems(lines.join('\n'), headingPattern, { includeCompleted: true })
    .filter((item) => normalizeChecklistText(item.text) === normalizedTarget);

  if (matches.length > 1) {
    throw new Error(`Multiple checklist items match "${itemText}" in ${heading}.`);
  }

  if (matches.length === 1) {
    const [match] = matches;
    if (!match.checked) return lines.join('\n');
    lines[match.lineIndex] = `- [ ] ${itemText.trim()}`;
    return lines.join('\n');
  }

  const insertionIndex = options.prepend ? section.bodyStartIndex : section.endIndex;
  lines.splice(insertionIndex, 0, `- [ ] ${itemText.trim()}`);
  return lines.join('\n');
}

function updateChecklistItemState(
  content: string,
  headingPattern: RegExp,
  headingLabel: string,
  itemText: string,
  checked: boolean,
): string {
  const lines = normalizeNoteContent(content).split('\n');
  const matches = extractChecklistItems(lines.join('\n'), headingPattern, { includeCompleted: true })
    .filter((item) => normalizeChecklistText(item.text) === normalizeChecklistText(itemText));

  if (matches.length === 0) {
    throw new Error(`${headingLabel} item not found: ${itemText}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple ${headingLabel.toLowerCase()} items match "${itemText}".`);
  }

  lines[matches[0].lineIndex] = `- [${checked ? 'x' : ' '}] ${itemText.trim()}`;
  return lines.join('\n');
}

function removeChecklistItem(
  content: string,
  headingPattern: RegExp,
  headingLabel: string,
  itemText: string,
): string {
  const lines = normalizeNoteContent(content).split('\n');
  const matches = extractChecklistItems(lines.join('\n'), headingPattern, { includeCompleted: true })
    .filter((item) => normalizeChecklistText(item.text) === normalizeChecklistText(itemText));

  if (matches.length === 0) {
    throw new Error(`${headingLabel} item not found: ${itemText}`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple ${headingLabel.toLowerCase()} items match "${itemText}".`);
  }

  lines.splice(matches[0].lineIndex, 1);
  return lines.join('\n');
}

function summarizeThread(thread: VaultNote): string {
  const frontmatter = thread.frontmatter as unknown as ThreadFrontmatter;
  const lines: string[] = [];

  lines.push(`Thread: ${frontmatter.name ?? frontmatter.thread_id}`);
  lines.push(`Status: ${frontmatter.status ?? ThreadStatus.Active}`);

  if (typeof frontmatter.description === 'string' && frontmatter.description.trim()) {
    lines.push(`Description: ${truncateInline(frontmatter.description, 180)}`);
  }

  const goals = Array.isArray(frontmatter.goals)
    ? frontmatter.goals
        .map((goal) => String(goal).trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  if (goals.length > 0) {
    lines.push('Goals:');
    for (const goal of goals) {
      lines.push(`- ${truncateInline(goal, 120)}`);
    }
  }

  const todoSummary = summarizeChecklist(
    'Todo',
    extractChecklistItems(thread.content, TODO_HEADING_PATTERN, { limit: 5 }),
  );
  if (todoSummary) {
    lines.push(todoSummary);
  }

  return lines.join('\n');
}

function firstNonHeadingLine(content: string): string | null {
  const lines = normalizeNoteContent(content).split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^\s{0,3}#{1,6}\s+/.test(rawLine)) continue;
    return line;
  }
  return null;
}

function inferInboxNoteTitle(relativePath: string, content: string): string {
  const heading = normalizeNoteContent(content)
    .split('\n')
    .find((line) => /^\s{0,3}#\s+/.test(line))
    ?.replace(/^\s{0,3}#\s+/, '')
    .trim();
  if (heading) return heading;

  const basename = relativePath.split('/').pop() ?? relativePath;
  return basename.replace(/\.md$/i, '');
}

function summarizeInboxNote(relativePath: string, content: string): string {
  const title = inferInboxNoteTitle(relativePath, content);
  const checklist = extractChecklistItems(content, INBOX_HEADING_PATTERN, { limit: 3 });
  if (checklist.length > 0) {
    return `${title} (${relativePath}): ${checklist.map((item) => item.text).join('; ')}`;
  }

  const preview = firstNonHeadingLine(content) ?? '(empty note)';
  return `${title} (${relativePath}): ${truncateInline(preview, 140)}`;
}

export class MemoryManager {
  /** Absolute path to the engram write root. */
  private readonly writeRoot: string;
  /** Absolute paths the assistant may read. */
  private readonly readRoots: string[];
  private readonly searchProvider: SearchProvider;

  constructor(
    private readonly adapter: FileSystemAdapter,
    private readonly config: MemoryConfig,
    searchProvider?: SearchProvider,
  ) {
    this.writeRoot = path.resolve(config.basePath, config.engramRoot);
    this.readRoots = [
      this.writeRoot,
      ...config.readPaths.map((p) => path.resolve(config.basePath, p)),
    ];
    this.searchProvider = searchProvider ?? new KeywordSearchProvider();
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

  private notesDir(): string {
    return path.join(this.writeRoot, this.config.notesPath);
  }

  private threadDir(): string {
    return path.join(this.writeRoot, this.config.threadsPath);
  }

  private threadPath(threadId: string): string {
    return path.join(this.threadDir(), `${threadId}.md`);
  }

  private contextLabelFor(note: VaultNote): string {
    const memoryRoot = path.join(this.writeRoot, this.config.memoryPath);
    return `memory:${path.relative(memoryRoot, note.path)}`;
  }

  private conversationDir(dateStr?: string): string {
    const base = path.join(this.writeRoot, this.config.conversationsPath);
    return dateStr ? path.join(base, dateStr) : base;
  }

  private normalizeNotePath(filePath: string): string {
    const notesRoot = this.notesDir();
    const resolved = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(notesRoot, filePath);
    const withExt = path.extname(resolved) ? resolved : `${resolved}.md`;

    if (withExt !== notesRoot && !withExt.startsWith(notesRoot + path.sep)) {
      throw new Error(
        `Note path must stay within the notes directory ("${notesRoot}")`,
      );
    }

    return withExt;
  }

  private noteRelativePath(filePath: string): string {
    return path.relative(this.notesDir(), filePath);
  }

  /** Directory for per-thread inbox notes: inbox/threads/<threadId>/ */
  private threadInboxPrefix(threadId: string): string {
    return `inbox/threads/${threadId}`;
  }

  /**
   * List inbox notes under a given prefix, sorted by created date (FIFO).
   * Parses each note to extract frontmatter `created` and body content.
   */
  private async listInboxNotes(
    prefix: string,
    options: { excludePrefix?: string; limit?: number } = {},
  ): Promise<Array<{ path: string; content: string; created: Date }>> {
    const notes = await this.listNotes({ prefix, limit: options.limit ?? 20 });
    const filtered = options.excludePrefix
      ? notes.filter((n) => !n.path.startsWith(options.excludePrefix!))
      : notes;

    const detailed = await Promise.all(
      filtered.map(async (note) => {
        const raw = await this.readNote(note.path);
        const parsed = VaultNote.parse(note.path, raw);
        const created = parsed.frontmatter.created
          ? new Date(parsed.frontmatter.created as string)
          : new Date(0);
        return {
          path: note.path,
          content: parsed.content || raw,
          created: isNaN(created.getTime()) ? new Date(0) : created,
        };
      }),
    );

    return detailed.sort((a, b) => a.created.getTime() - b.created.getTime());
  }

  private workingDir(): string {
    return path.join(this.writeRoot, this.config.workingPath);
  }

  private archiveDir(): string {
    return path.join(this.writeRoot, this.config.archivePath);
  }

  private async mutateVaultNote(
    filePath: string,
    mutate: (note: VaultNote) => void,
  ): Promise<VaultNote> {
    this.assertWriteAllowed(filePath);

    if (supportsProcess(this.adapter)) {
      let finalSerialized = '';

      await this.adapter.process(filePath, (raw) => {
        const note = VaultNote.parse(filePath, raw);
        const before = note.serialize();
        mutate(note);

        if (note.serialize() === before) {
          finalSerialized = raw;
          return raw;
        }

        note.frontmatter.updated = new Date().toISOString();
        finalSerialized = note.serialize();
        return finalSerialized;
      });

      if (!finalSerialized) {
        finalSerialized = await this.adapter.read(filePath);
      }

      return VaultNote.parse(filePath, finalSerialized);
    }

    const note = await VaultNote.read(this.adapter, filePath);
    const before = note.serialize();
    mutate(note);
    if (note.serialize() === before) {
      return note;
    }
    await note.save(this.adapter);
    return note;
  }

  private async requireThread(threadId: string): Promise<VaultNote> {
    const thread = await this.getThread(threadId);
    if (!thread) throw new Error(`Thread not found: ${threadId}`);
    return thread;
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
   * Build context sections for prompt assembly.
   *
   * Loading strategy:
   *  - Active thread summary: included when threadId is provided (priority 100)
   *  - Global inbox: included when notes exist under engram/notes/inbox/ (priority 98)
   *  - Active thread inbox: included when thread inbox notes exist (priority 95)
   *  - Core memories: always included (priority 90), summary preferred
   *  - Remembered memories: included at priority 70 (65 if query-irrelevant)
   *  - Default memories: included only when query-relevant (priority 40-60)
   *  - All non-core memories load summaries only; notes without summaries are skipped
   *
   * The Soul document is intentionally excluded — load it separately via
   * getSoulDocument() / the `soul` MCP tool so harnesses that inject it at the
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

    const coreNotes: VaultNote[] = [];
    const rememberedNotes: VaultNote[] = [];
    const defaultNotes: VaultNote[] = [];

    for (const n of valid) {
      if (n.path === soulPath) continue;
      const state = n.frontmatter.memory_state;

      if (state === MemoryState.Core) {
        coreNotes.push(n);
        continue;
      }

      // Thread filtering: exclude notes scoped to a different thread
      if (threadId) {
        const noteThread = n.frontmatter.thread as string | undefined;
        if (noteThread && noteThread !== threadId) continue;
      }

      if (state === MemoryState.Remembered) {
        rememberedNotes.push(n);
      } else if (state === MemoryState.Default) {
        defaultNotes.push(n);
      }
    }

    const builder = new ContextBuilder();

    const globalInboxSummary = await this.getGlobalInboxSummary(threadId);
    if (globalInboxSummary) {
      builder.addSection('inbox:global', globalInboxSummary, 98);
    }

    if (threadId) {
      const thread = await this.getThread(threadId);
      if (thread) {
        builder.addSection(`thread:${threadId}`, summarizeThread(thread), 100);
      }

      const inboxSummary = await this.getThreadInboxSummary(threadId);
      if (inboxSummary) {
        builder.addSection(`thread-inbox:${threadId}`, inboxSummary, 95);
      }
    }

    // Core: always load. Use summary if available and content is large.
    for (const n of coreNotes) {
      const summary = n.frontmatter.summary as string | undefined;
      const body = summary && builder.estimateTokens(n.content) > 200
        ? summary
        : n.content;
      builder.addSection(this.contextLabelFor(n), body, 90);
    }

    const hasQuery = query && query.trim().length > 0;

    if (hasQuery) {
      // Score all non-core notes against the query
      const allCandidates = [...rememberedNotes, ...defaultNotes];
      const scored = this.searchProvider.rank(query, allCandidates);
      const scoredPaths = new Set(scored.map((s) => s.note.path));

      // Query-relevant notes get priority based on state + score
      for (const { note, score } of scored) {
        const body = summaryOnly(note);
        if (!body) continue;
        if (note.frontmatter.memory_state === MemoryState.Remembered) {
          builder.addSection(this.contextLabelFor(note), body, 70);
        } else {
          // Default: priority 40-60 scaled by relevance
          builder.addSection(this.contextLabelFor(note), body, 40 + Math.round(score * 20));
        }
      }

      // Remembered notes that didn't match the query still load, but at lower priority
      for (const n of rememberedNotes) {
        if (!scoredPaths.has(n.path)) {
          const body = summaryOnly(n);
          if (!body) continue;
          builder.addSection(this.contextLabelFor(n), body, 65);
        }
      }
    } else {
      // No query: backward-compatible behavior — all remembered, no defaults
      for (const n of rememberedNotes) {
        const body = summaryOnly(n);
        if (!body) continue;
        builder.addSection(this.contextLabelFor(n), body, 70);
      }
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

  async listThreadTodos(
    threadId: string,
    options: { includeCompleted?: boolean } = {},
  ): Promise<Array<{ text: string; checked: boolean }>> {
    const thread = await this.requireThread(threadId);

    return extractChecklistItems(thread.content, TODO_HEADING_PATTERN, {
      includeCompleted: options.includeCompleted,
    }).map((item) => ({
      text: item.text,
      checked: item.checked,
    }));
  }

  async addThreadTodo(
    threadId: string,
    itemText: string,
    options: { prepend?: boolean } = {},
  ): Promise<VaultNote> {
    await this.requireThread(threadId);
    return this.mutateVaultNote(this.threadPath(threadId), (note) => {
      note.content = addChecklistItem(
        note.content,
        'Todo',
        TODO_HEADING_PATTERN,
        itemText,
        options,
      );
    });
  }

  async completeThreadTodo(threadId: string, itemText: string): Promise<VaultNote> {
    await this.requireThread(threadId);
    return this.mutateVaultNote(this.threadPath(threadId), (note) => {
      note.content = updateChecklistItemState(
        note.content,
        TODO_HEADING_PATTERN,
        'Todo',
        itemText,
        true,
      );
    });
  }

  async reopenThreadTodo(threadId: string, itemText: string): Promise<VaultNote> {
    await this.requireThread(threadId);
    return this.mutateVaultNote(this.threadPath(threadId), (note) => {
      note.content = updateChecklistItemState(
        note.content,
        TODO_HEADING_PATTERN,
        'Todo',
        itemText,
        false,
      );
    });
  }

  async removeThreadTodo(threadId: string, itemText: string): Promise<VaultNote> {
    await this.requireThread(threadId);
    return this.mutateVaultNote(this.threadPath(threadId), (note) => {
      note.content = removeChecklistItem(
        note.content,
        TODO_HEADING_PATTERN,
        'Todo',
        itemText,
      );
    });
  }

  async listThreadInbox(
    threadId: string,
  ): Promise<Array<{ path: string; content: string; created: string }>> {
    const prefix = this.threadInboxPrefix(threadId);
    const notes = await this.listInboxNotes(prefix);

    if (notes.length > 0) return notes.map((n) => ({
      path: n.path,
      content: n.content,
      created: n.created.getTime() === 0 ? '' : n.created.toISOString(),
    }));

    // Legacy fallback: single file at inbox/threads/<threadId>.md or inbox/<threadId>.md
    const legacyCandidates = [
      this.normalizeNotePath(path.join('inbox', 'threads', threadId)),
      this.normalizeNotePath(path.join('inbox', threadId)),
    ];
    for (const legacyPath of legacyCandidates) {
      if (await this.adapter.exists(legacyPath)) {
        const raw = await this.adapter.read(legacyPath);
        const parsed = VaultNote.parse(legacyPath, raw);
        const created = parsed.frontmatter.created
          ? new Date(parsed.frontmatter.created as string)
          : new Date(0);
        return [{
          path: this.noteRelativePath(legacyPath),
          content: parsed.content || raw,
          created: isNaN(created.getTime()) ? '' : created.toISOString(),
        }];
      }
    }

    return [];
  }

  async addThreadInboxItem(
    threadId: string,
    itemText: string,
  ): Promise<string> {
    const slug = slugify(itemText.slice(0, 60));
    const notePath = path.join('inbox', 'threads', threadId, slug);
    const now = new Date().toISOString();
    const noteContent = `---\ncreated: ${now}\n---\n\n${itemText}`;
    return this.createNote(notePath, noteContent);
  }

  async completeThreadInboxItem(threadId: string, item: string): Promise<string> {
    return this.removeThreadInboxItem(threadId, item);
  }

  async removeThreadInboxItem(threadId: string, item: string): Promise<string> {
    const items = await this.listThreadInbox(threadId);
    const itemSlug = slugify(item.slice(0, 60));
    const match = items.find((i) => {
      const filename = i.path.split('/').pop()?.replace(/\.md$/, '') ?? '';
      return (
        i.path === item ||
        i.path.endsWith(`/${item}`) ||
        i.path.endsWith(`/${item}.md`) ||
        i.path.replace(/\.md$/, '') === item ||
        filename === itemSlug
      );
    });
    if (!match) throw new Error(`Inbox item not found: ${item}`);
    return this.deleteNote(match.path);
  }

  async getThreadInboxSummary(threadId: string): Promise<string | null> {
    const items = await this.listThreadInbox(threadId).catch(() => []);
    if (items.length === 0) return null;
    return [
      `Thread Inbox (${threadId}):`,
      ...items.slice(0, 5).map((item) => `- ${summarizeInboxNote(item.path, item.content)}`),
    ].join('\n');
  }

  async listGlobalInbox(): Promise<Array<{ path: string; content: string; created: string }>> {
    const notes = await this.listInboxNotes('inbox', {
      excludePrefix: 'inbox/threads/',
      limit: 20,
    });
    return notes.map((n) => ({
      path: n.path,
      content: n.content,
      created: n.created.getTime() === 0 ? '' : n.created.toISOString(),
    }));
  }

  async addGlobalInboxItem(content: string, name?: string): Promise<string> {
    const slug = name ?? slugify(content.slice(0, 60));
    const notePath = path.join('inbox', slug);
    const now = new Date().toISOString();
    const noteContent = `---\ncreated: ${now}\n---\n\n${content}`;
    return this.createNote(notePath, noteContent);
  }

  async removeInboxItem(itemPath: string): Promise<string> {
    return this.deleteNote(itemPath);
  }

  async getGlobalInboxSummary(activeThreadId?: string): Promise<string | null> {
    const notes = await this.listGlobalInbox();
    if (notes.length === 0) return null;

    return [
      'Global Inbox:',
      ...notes.slice(0, 5).map((note) => `- ${summarizeInboxNote(note.path, note.content)}`),
    ].join('\n');
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
    return this.adapter.read(target);
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

    if (!(await this.adapter.exists(target))) {
      throw new Error(`Note not found: ${target}`);
    }

    const nextContent = normalizeNoteContent(content);
    const expected = expectedCurrentContent !== undefined
      ? normalizeNoteContent(expectedCurrentContent)
      : undefined;

    if (supportsProcess(this.adapter)) {
      let conflictDetected = false;
      await this.adapter.process(target, (current) => {
        const normalizedCurrent = normalizeNoteContent(current);
        if (expected !== undefined && normalizedCurrent !== expected) {
          conflictDetected = true;
          return current;
        }
        if (normalizedCurrent === nextContent) {
          return current;
        }
        return nextContent;
      });

      if (conflictDetected) {
        throw new Error(`Note changed since last read: ${target}`);
      }

      return target;
    }

    const current = normalizeNoteContent(await this.adapter.read(target));
    if (expected !== undefined && current !== expected) {
      throw new Error(`Note changed since last read: ${target}`);
    }
    if (current !== nextContent) {
      await this.adapter.write(target, nextContent);
    }
    return target;
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

    const addition = normalizeNoteContent(content);
    const expected = options.expectedCurrentContent !== undefined
      ? normalizeNoteContent(options.expectedCurrentContent)
      : undefined;
    const separator = normalizeNoteContent(options.separator ?? '\n\n');

    if (supportsProcess(this.adapter)) {
      let conflictDetected = false;

      await this.adapter.process(target, (current) => {
        const normalizedCurrent = normalizeNoteContent(current);
        if (expected !== undefined && normalizedCurrent !== expected) {
          conflictDetected = true;
          return current;
        }
        if (!normalizedCurrent) {
          return addition;
        }
        if (!addition) {
          return current;
        }
        return `${normalizedCurrent}${separator}${addition}`;
      });

      if (conflictDetected) {
        throw new Error(`Note changed since last read: ${target}`);
      }

      return target;
    }

    const exists = await this.adapter.exists(target);
    const current = exists
      ? normalizeNoteContent(await this.adapter.read(target))
      : '';
    if (expected !== undefined && current !== expected) {
      throw new Error(`Note changed since last read: ${target}`);
    }

    const nextContent = !current
      ? addition
      : !addition
        ? current
        : `${current}${separator}${addition}`;

    if (!exists) {
      await this.adapter.mkdir(path.dirname(target));
      await this.adapter.write(target, nextContent);
      return target;
    }
    if (current !== nextContent) {
      await this.adapter.write(target, nextContent);
    }
    return target;
  }

  /**
   * List markdown notes under engram/notes.
   */
  async listNotes(options: {
    limit?: number;
    prefix?: string;
  } = {}): Promise<Array<{ path: string; preview: string }>> {
    const notesRoot = this.notesDir();
    const files = await this.adapter.list(notesRoot).catch(() => [] as string[]);
    const prefix = options.prefix
      ? options.prefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
      : undefined;

    const filtered = files
      .map((filePath) => this.noteRelativePath(filePath))
      .filter((relativePath) => !prefix || relativePath === prefix || relativePath.startsWith(prefix + '/'))
      .sort((a, b) => a.localeCompare(b))
      .slice(0, options.limit ?? 20);

    const results = await Promise.all(
      filtered.map(async (relativePath) => {
        const content = await this.readNote(relativePath);
        return {
          path: relativePath,
          preview: content.slice(0, 200),
        };
      }),
    );

    return results;
  }

  /**
   * Search markdown notes under engram/notes.
   */
  async searchNotes(
    query: string,
    options: { limit?: number } = {},
  ): Promise<Array<{ path: string; preview: string; score?: number }>> {
    const notesRoot = this.notesDir();
    const results = await this.adapter.search(query, notesRoot).catch(() => [] as Array<{
      path: string;
      content: string;
      score?: number;
    }>);

    return results
      .slice(0, options.limit ?? 10)
      .map((result) => ({
        path: this.noteRelativePath(result.path),
        preview: result.content.slice(0, 200),
        score: result.score,
      }));
  }

  /**
   * Delete an existing raw note from engram/notes.
   */
  async deleteNote(filePath: string): Promise<string> {
    const target = this.normalizeNotePath(filePath);
    this.assertWriteAllowed(target);

    if (!(await this.adapter.exists(target))) {
      throw new Error(`Note not found: ${target}`);
    }

    await this.adapter.delete(target);
    return target;
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

  private bootstrapScratchEntries(
    entries: ScratchEntry[],
    limit: number,
    since?: string,
  ): ScratchEntry[] {
    const now = Date.now();
    const ageCutoff = now - 7 * 24 * 60 * 60 * 1000;
    const compactedCutoff = now - 72 * 60 * 60 * 1000;
    const sinceTs = since ? new Date(since).getTime() : null;
    const transformed: ScratchEntry[] = [];

    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      const entryTs = new Date(entry.timestamp).getTime();

      if (entryTs < ageCutoff) continue;
      if (sinceTs !== null && entryTs < sinceTs) continue;

      if (entry.content.startsWith('[COMPACTED]') && entryTs < compactedCutoff) {
        continue;
      }

      if (!entry.content.startsWith('[DREAM START]')) {
        transformed.push(entry);
        continue;
      }

      let dreamNarrative: ScratchEntry | null = null;
      let dreamEnd: ScratchEntry | null = null;
      let cursor = index + 1;

      while (cursor < entries.length) {
        const candidate = entries[cursor];
        const candidateTs = new Date(candidate.timestamp).getTime();

        if (candidateTs >= ageCutoff && (sinceTs === null || candidateTs >= sinceTs)) {
          if (candidate.content.startsWith('[DREAMING]')) {
            dreamNarrative = candidate;
          }
          if (candidate.content.startsWith('[DREAM END]')) {
            dreamEnd = candidate;
            break;
          }
        }

        cursor += 1;
      }

      if (!dreamEnd) {
        continue;
      }

      if (dreamNarrative) {
        transformed.push(dreamNarrative);
      }

      const stats = dreamEnd.content
        .replace(/^\[DREAM END\]\s*/, '')
        .split('|')[0]
        ?.trim();
      if (stats) {
        transformed.push({
          ...dreamEnd,
          content: `[DREAM SUMMARY] ${stats}`,
        });
      }

      index = cursor;
    }

    transformed.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    const limited = transformed.slice(0, limit);
    limited.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    return limited;
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

    if (supportsProcess(this.adapter)) {
      await this.adapter.process(logPath, (existing) =>
        existing.trim() ? `${existing.trimEnd()}\n${line}` : line,
      );
      return;
    }

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

    if (options.bootstrap) {
      return this.bootstrapScratchEntries(entries, options.limit ?? 10, options.since);
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

    if (supportsProcess(this.adapter)) {
      if (!(await this.adapter.exists(logPath))) return;

      await this.adapter.process(logPath, (raw) => {
        if (!raw.trim()) return raw;

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

        if (toRemove.size < 2) return raw;

        const compactLine = `[${options.sessionId} | ${new Date().toISOString()}] [COMPACTED] ${options.compactedContent.replace(/\n+/g, ' | ')}`;

        return lines
          .map((line, idx) => {
            if (idx === firstIdx) return compactLine;
            if (toRemove.has(idx)) return null;
            return line;
          })
          .filter((line): line is string => line !== null)
          .join('\n');
      });
      return;
    }

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
   * Remove scratch entries for a session older than thresholdMs.
   * Returns the number of entries deleted.
   */
  async pruneScratch(options: ScratchPruneOptions): Promise<number> {
    const logPath = this.scratchFilePath;
    this.assertWriteAllowed(logPath);

    const pruneLines = (raw: string): { content: string; removed: number } => {
      if (!raw.trim()) return { content: raw, removed: 0 };

      const lines = raw.split('\n');
      const entryPattern = /^\[([^\]]+) \| ([^\]]+)\] (.+)$/;
      const cutoff = Date.now() - options.thresholdMs;
      let removed = 0;

      const kept = lines.filter((line) => {
        const match = line.match(entryPattern);
        if (!match || match[1] !== options.sessionId) return true;
        if (new Date(match[2]).getTime() > cutoff) return true;
        removed += 1;
        return false;
      });

      return { content: kept.join('\n'), removed };
    };

    if (supportsProcess(this.adapter)) {
      if (!(await this.adapter.exists(logPath))) return 0;

      let removed = 0;
      await this.adapter.process(logPath, (raw) => {
        const result = pruneLines(raw);
        removed = result.removed;
        return result.content;
      });
      return removed;
    }

    const raw = await this.adapter.read(logPath).catch(() => '');
    if (!raw.trim()) return 0;

    const result = pruneLines(raw);
    if (result.removed === 0) return 0;
    await this.adapter.write(logPath, result.content);
    return result.removed;
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
