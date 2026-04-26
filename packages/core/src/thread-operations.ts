import * as path from 'node:path';
import type { FileSystemAdapter } from './adapters/types.js';
import { ThreadStatus } from './types.js';
import type { MemoryFilters, NoteFrontmatter, ThreadFields } from './types.js';
import {
  addChecklistItem,
  expandHome,
  extractChecklistItems,
  getTodoHeadingPattern,
  readNonEmptyString,
  readStringArray,
  removeChecklistItem,
  summarizeInboxNote,
  threadInboxPrefix,
  updateChecklistItemState,
} from './memory-helpers.js';
import {
  listInboxNotes,
  readLegacyThreadInbox,
  serializeInboxNote,
  stripMarkdownExtension,
} from './note-helpers.js';
import {
  buildThreadFrontmatter,
  mergeThreadDescription,
  mergeUniqueStrings,
  pickBestThreadMatch,
  rankThreadMatches,
  resolveThreadIdOrThrow,
  type ThreadMatch,
} from './thread-helpers.js';
import {
  collectFieldUpdates,
  computeSuppressedIds,
  describeAlternateCandidates,
  describeRelatedThreadCandidates,
  followSupersededBy,
  parseLastActiveMs,
  type ResolvedThreadCandidate,
} from './thread-resolve-helpers.js';
import { detectGitRemote, normalizeRemoteUrl, type GitRemoteDetector } from './git-remote.js';
import { detectPackageNames, type PackageNameDetector } from './package-name.js';
import { VaultNote } from './vault.js';
import { slugify } from './utils.js';

const EMPTY_CONTENT = '';
const MAX_INBOX_NOTE_SLUG_LENGTH = 60;
const INBOX_SUMMARY_LIMIT = 5;
const DEFAULT_LIST_LIMIT = 20;
const ISO_DATE_LENGTH = 10;

interface ThreadOperationDependencies {
  adapter: FileSystemAdapter;
  assertWriteAllowed: (filePath: string) => void;
  createNote: (filePath: string, content: string) => Promise<string>;
  deleteNote: (filePath: string) => Promise<string>;
  listNotes: (options?: { limit?: number; prefix?: string }) => Promise<Array<{ path: string; preview: string }>>;
  readNote: (filePath: string) => Promise<string>;
  normalizeNotePath: (filePath: string) => string;
  noteRelativePath: (filePath: string) => string;
  listMemories: (filters?: MemoryFilters) => Promise<VaultNote[]>;
  updateMemory: (
    filePath: string,
    content?: string,
    frontmatterUpdates?: Partial<NoteFrontmatter>,
  ) => Promise<VaultNote>;
  threadDir: () => string;
  threadPath: (threadId: string) => string;
  mutateThread: (
    filePath: string,
    transform: (content: string) => string,
  ) => Promise<VaultNote>;
  detectGitRemote?: GitRemoteDetector;
  detectPackageNames?: PackageNameDetector;
}

const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1_000;
const LAST_ACTIVE_THROTTLE_MS = MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

export type { ResolvedThreadCandidate } from './thread-resolve-helpers.js';

export interface ResolvedThread {
  threadId: string;
  created: boolean;
  /** True when an existing planned thread was auto-promoted to active by this resolve call. */
  activated: boolean;
  thread: VaultNote;
  /** Other plausible matches when the result is ambiguous (e.g. multiple remote matches or likely rename). */
  candidates?: ResolvedThreadCandidate[];
}

export class ThreadOperations {
  constructor(private readonly deps: ThreadOperationDependencies) {}

  private async requireThread(threadId: string): Promise<VaultNote> {
    const thread = await this.getThread(threadId);
    if (thread === null) {
      throw new Error(`Thread not found: ${threadId}`);
    }

    return thread;
  }

  async getThread(threadId: string): Promise<VaultNote | null> {
    const direct = await VaultNote.read(this.deps.adapter, this.deps.threadPath(threadId)).catch(() => null);
    if (direct !== null) {
      return direct;
    }
    const threads = await this.listThreads();
    return threads.find((thread) =>
      readStringArray(thread.frontmatter.aliases).includes(threadId),
    ) ?? null;
  }

  async setThread(
    threadId: string,
    content: string,
    fields: ThreadFields = {},
  ): Promise<VaultNote> {
    const dir = this.deps.threadDir();
    const filePath = this.deps.threadPath(threadId);
    this.deps.assertWriteAllowed(filePath);
    await this.deps.adapter.mkdir(dir);
    const existing = await VaultNote.read(this.deps.adapter, filePath).catch(() => null);
    const frontmatter = buildThreadFrontmatter(threadId, existing, fields);
    return await VaultNote.create(this.deps.adapter, filePath, frontmatter, content);
  }

  async updateThread(
    threadId: string,
    content?: string,
    fields?: ThreadFields,
  ): Promise<VaultNote> {
    const filePath = this.deps.threadPath(threadId);
    this.deps.assertWriteAllowed(filePath);

    const note = await VaultNote.read(this.deps.adapter, filePath);

    if (content !== undefined) {
      note.content = content;
    }
    if (fields !== undefined) {
      const updates: Partial<NoteFrontmatter> = collectFieldUpdates(fields);
      note.updateFrontmatter({
        ...updates,
        updated: new Date().toISOString(),
        ...(fields.status === undefined ? {} : { status: fields.status }),
      });
    }

    await note.save(this.deps.adapter);
    return note;
  }

  async listThreads(): Promise<VaultNote[]> {
    const files = await this.deps.adapter.list(this.deps.threadDir()).catch(() => [] as string[]);
    const notes = await Promise.all(
      files.map(async (filePath) => await VaultNote.read(this.deps.adapter, filePath).catch(() => null)),
    );
    return notes.filter((note): note is VaultNote => note !== null);
  }

  async listThreadTodos(
    threadId: string,
    options: { includeCompleted?: boolean } = {},
  ): Promise<Array<{ text: string; checked: boolean }>> {
    const thread = await this.requireThread(threadId);

    return extractChecklistItems(thread.content, getTodoHeadingPattern(), {
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
    return await this.deps.mutateThread(this.deps.threadPath(threadId), (content) =>
      addChecklistItem(content, {
        heading: 'Todo',
        headingLabel: 'Todo',
        headingPattern: getTodoHeadingPattern(),
        itemText,
        prepend: options.prepend,
      }),
    );
  }

  async completeThreadTodo(threadId: string, itemText: string): Promise<VaultNote> {
    await this.requireThread(threadId);
    return await this.deps.mutateThread(this.deps.threadPath(threadId), (content) =>
      updateChecklistItemState(content, {
        headingLabel: 'Todo',
        headingPattern: getTodoHeadingPattern(),
        itemText,
        checked: true,
      }),
    );
  }

  async reopenThreadTodo(threadId: string, itemText: string): Promise<VaultNote> {
    await this.requireThread(threadId);
    return await this.deps.mutateThread(this.deps.threadPath(threadId), (content) =>
      updateChecklistItemState(content, {
        headingLabel: 'Todo',
        headingPattern: getTodoHeadingPattern(),
        itemText,
        checked: false,
      }),
    );
  }

  async removeThreadTodo(threadId: string, itemText: string): Promise<VaultNote> {
    await this.requireThread(threadId);
    return await this.deps.mutateThread(this.deps.threadPath(threadId), (content) =>
      removeChecklistItem(content, {
        headingLabel: 'Todo',
        headingPattern: getTodoHeadingPattern(),
        itemText,
      }),
    );
  }

  async listThreadInbox(
    threadId: string,
  ): Promise<Array<{ path: string; content: string; created: string }>> {
    const notes = await listInboxNotes(
      async (options) => await this.deps.listNotes(options),
      async (filePath) => await this.deps.readNote(filePath),
      threadInboxPrefix(threadId),
    );

    if (notes.length > 0) {
      return notes.map((note) => serializeInboxNote(note));
    }

    const legacyNote = await readLegacyThreadInbox(
      this.deps.adapter,
      threadId,
      (filePath) => this.deps.normalizeNotePath(filePath),
      (filePath) => this.deps.noteRelativePath(filePath),
    );
    return legacyNote === null ? [] : [legacyNote];
  }

  async addThreadInboxItem(threadId: string, itemText: string): Promise<string> {
    const slug = slugify(itemText.slice(0, MAX_INBOX_NOTE_SLUG_LENGTH));
    const notePath = path.join('inbox', 'threads', threadId, slug);
    const now = new Date().toISOString();
    return await this.deps.createNote(notePath, `---\ncreated: ${now}\n---\n\n${itemText}`);
  }

  async completeThreadInboxItem(threadId: string, item: string): Promise<string> {
    return await this.removeThreadInboxItem(threadId, item);
  }

  async removeThreadInboxItem(threadId: string, item: string): Promise<string> {
    const items = await this.listThreadInbox(threadId);
    const itemSlug = slugify(item.slice(0, MAX_INBOX_NOTE_SLUG_LENGTH));
    const match = items.find((entry) => {
      const filename = stripMarkdownExtension(entry.path.split('/').pop() ?? EMPTY_CONTENT);
      return (
        entry.path === item ||
        entry.path.endsWith(`/${item}`) ||
        entry.path.endsWith(`/${item}.md`) ||
        stripMarkdownExtension(entry.path) === item ||
        filename === itemSlug
      );
    });
    if (match === undefined) {
      throw new Error(`Inbox item not found: ${item}`);
    }

    return await this.deps.deleteNote(match.path);
  }

  async getThreadInboxSummary(threadId: string): Promise<string | null> {
    const items = await this.listThreadInbox(threadId).catch(() => []);
    if (items.length === 0) {
      return null;
    }

    return [
      `Thread Inbox (${threadId}):`,
      ...items.slice(0, INBOX_SUMMARY_LIMIT).map((item) => `- ${summarizeInboxNote(item.path, item.content)}`),
    ].join('\n');
  }

  async listGlobalInbox(): Promise<Array<{ path: string; content: string; created: string }>> {
    const notes = await listInboxNotes(
      async (options) => await this.deps.listNotes(options),
      async (filePath) => await this.deps.readNote(filePath),
      'inbox',
      {
        excludePrefix: 'inbox/threads/',
        limit: DEFAULT_LIST_LIMIT,
      },
    );
    return notes.map((note) => serializeInboxNote(note));
  }

  async addGlobalInboxItem(content: string, name?: string): Promise<string> {
    const slug = name ?? slugify(content.slice(0, MAX_INBOX_NOTE_SLUG_LENGTH));
    const notePath = path.join('inbox', slug);
    const now = new Date().toISOString();
    return await this.deps.createNote(notePath, `---\ncreated: ${now}\n---\n\n${content}`);
  }

  async removeInboxItem(itemPath: string): Promise<string> {
    return await this.deps.deleteNote(itemPath);
  }

  async getGlobalInboxSummary(_activeThreadId?: string): Promise<string | null> {
    const notes = await this.listGlobalInbox();
    if (notes.length === 0) {
      return null;
    }

    return [
      'Global Inbox:',
      ...notes.slice(0, INBOX_SUMMARY_LIMIT).map((note) => `- ${summarizeInboxNote(note.path, note.content)}`),
    ].join('\n');
  }

  async resolveThread(hints: {
    cwd?: string;
    gitRemote?: string;
    autoCreate?: boolean;
  }): Promise<ResolvedThread> {
    const cwd = path.resolve(expandHome(hints.cwd ?? process.cwd()));
    const gitRemote = hints.gitRemote ?? (this.deps.detectGitRemote ?? detectGitRemote)(cwd);
    const packageNames = (this.deps.detectPackageNames ?? detectPackageNames)(cwd);

    const threads = await this.listThreads();
    const matchHints = { gitRemote, packageNames };
    const matches = rankThreadMatches(threads, cwd, matchHints);
    const initialBest = pickBestThreadMatch(threads, cwd, matchHints);

    if (initialBest !== null) {
      return await this.finalizeResolvedMatch(initialBest, threads, matches);
    }

    if (hints.autoCreate === false) {
      throw new Error(`No matching thread found for cwd: ${cwd}`);
    }

    return await this.createThreadForCwd(cwd, gitRemote, packageNames);
  }

  private async finalizeResolvedMatch(
    initialBest: VaultNote,
    threads: VaultNote[],
    matches: ThreadMatch[],
  ): Promise<ResolvedThread> {
    const { resolved, chain } = followSupersededBy(initialBest, threads);
    const finalId = resolveThreadIdOrThrow(resolved);
    const suppressIds = computeSuppressedIds(threads, finalId, chain);
    const matchCandidates = describeAlternateCandidates(matches, suppressIds);
    const matchedIds = new Set(matchCandidates.map((c) => c.threadId));
    const relatedSuppress = new Set([...suppressIds, ...matchedIds]);
    const relatedCandidates = describeRelatedThreadCandidates(resolved, threads, relatedSuppress);
    const candidates = [...matchCandidates, ...relatedCandidates];
    const activated = await this.promoteIfPlanned(resolved);
    if (!activated) {
      await this.bumpLastActive(resolved);
    }
    const result: ResolvedThread = { threadId: finalId, created: false, activated, thread: resolved };
    if (candidates.length > 0) {
      result.candidates = candidates;
    }
    return result;
  }

  private async promoteIfPlanned(thread: VaultNote): Promise<boolean> {
    if (thread.frontmatter.status !== ThreadStatus.Planned) {
      return false;
    }
    const now = new Date().toISOString();
    thread.updateFrontmatter({
      status: ThreadStatus.Active,
      activated_at: now,
      last_active: now,
    });
    await thread.save(this.deps.adapter);
    return true;
  }

  private async createThreadForCwd(
    cwd: string,
    gitRemote: string | undefined,
    packageNames: string[],
  ): Promise<ResolvedThread> {
    const threadId = slugify(path.basename(cwd));
    const repositories = gitRemote === undefined ? undefined : [normalizeRemoteUrl(gitRemote)];
    const thread = await this.setThread(threadId, EMPTY_CONTENT, {
      name: path.basename(cwd),
      paths: [cwd],
      ...(repositories === undefined ? {} : { repositories }),
      ...(packageNames.length === 0 ? {} : { packages: packageNames }),
    });
    await this.bumpLastActive(thread);
    return { threadId, created: true, activated: false, thread };
  }

  private async bumpLastActive(thread: VaultNote): Promise<void> {
    const now = Date.now();
    if (now - parseLastActiveMs(thread.frontmatter.last_active) < LAST_ACTIVE_THROTTLE_MS) {
      return;
    }
    thread.updateFrontmatter({ last_active: new Date(now).toISOString() });
    await thread.save(this.deps.adapter);
  }

  async mergeThreads(
    sourceId: string,
    targetId: string,
  ): Promise<{ retaggedCount: number }> {
    const source = await this.getThread(sourceId);
    if (source === null) {
      throw new Error(`Source thread not found: ${sourceId}`);
    }
    const target = await this.getThread(targetId);
    if (target === null) {
      throw new Error(`Target thread not found: ${targetId}`);
    }

    const sourceMemos = await this.deps.listMemories({ thread: sourceId });
    await Promise.all(
      sourceMemos.map(async (note) =>
        await this.deps.updateMemory(note.path, undefined, { thread: targetId }),
      ),
    );

    const mergedPaths = mergeUniqueStrings(
      readStringArray(target.frontmatter.paths),
      readStringArray(source.frontmatter.paths),
    );
    const mergedGoals = mergeUniqueStrings(
      readStringArray(target.frontmatter.goals),
      readStringArray(source.frontmatter.goals),
    );
    const mergedRelated = mergeUniqueStrings(
      readStringArray(target.frontmatter.related_threads),
      readStringArray(source.frontmatter.related_threads),
    ).filter((id) => id !== sourceId && id !== targetId);
    const mergedAliases = mergeUniqueStrings(
      readStringArray(target.frontmatter.aliases),
      readStringArray(source.frontmatter.aliases),
      [sourceId],
    ).filter((id) => id !== targetId);
    const mergedDescription = mergeThreadDescription(
      readNonEmptyString(target.frontmatter.description) ?? EMPTY_CONTENT,
      sourceId,
      readNonEmptyString(source.frontmatter.description) ?? EMPTY_CONTENT,
    );

    await this.updateThread(targetId, undefined, {
      paths: mergedPaths.length > 0 ? mergedPaths : undefined,
      goals: mergedGoals.length > 0 ? mergedGoals : undefined,
      related_threads: mergedRelated.length > 0 ? mergedRelated : undefined,
      aliases: mergedAliases.length > 0 ? mergedAliases : undefined,
      description: mergedDescription,
    });

    const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH);
    await this.updateThread(
      sourceId,
      `Merged into [[${targetId}]] on ${date}. All memories re-tagged to target thread.`,
      { status: ThreadStatus.Closed, superseded_by: targetId },
    );

    return { retaggedCount: sourceMemos.length };
  }
}

