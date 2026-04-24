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
import { detectGitRemote, normalizeRemoteUrl, type GitRemoteDetector } from './git-remote.js';
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
}

export interface ResolvedThreadCandidate {
  threadId: string;
  name: string;
  reason: 'remote' | 'path';
}

export interface ResolvedThread {
  threadId: string;
  created: boolean;
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
    return await VaultNote.read(this.deps.adapter, this.deps.threadPath(threadId)).catch(() => null);
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
      const updates: Partial<NoteFrontmatter> = { updated: new Date().toISOString() };
      const {
        name,
        description,
        status,
        goals,
        paths,
        related_threads: relatedThreads,
        tags,
      } = fields;
      if (name !== undefined) {
        updates.name = name;
      }
      if (description !== undefined) {
        updates.description = description;
      }
      if (goals !== undefined) {
        updates.goals = goals;
      }
      if (paths !== undefined) {
        updates.paths = paths;
      }
      if (relatedThreads !== undefined) {
        updates.related_threads = relatedThreads;
      }
      if (tags !== undefined) {
        updates.tags = tags;
      }

      note.updateFrontmatter(status === undefined ? updates : { ...updates, status });
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
    const autoCreate = hints.autoCreate ?? true;
    const detector = this.deps.detectGitRemote ?? detectGitRemote;
    const gitRemote = hints.gitRemote ?? detector(cwd);

    const threads = await this.listThreads();
    const matches = rankThreadMatches(threads, cwd, gitRemote);
    const bestThread = pickBestThreadMatch(threads, cwd, gitRemote);

    if (bestThread !== null) {
      const bestId = resolveThreadIdOrThrow(bestThread);
      const candidates = describeAlternateCandidates(matches, bestId);
      const result: ResolvedThread = {
        threadId: bestId,
        created: false,
        thread: bestThread,
      };
      if (candidates.length > 0) {
        result.candidates = candidates;
      }
      return result;
    }

    if (!autoCreate) {
      throw new Error(`No matching thread found for cwd: ${cwd}`);
    }

    const threadId = slugify(path.basename(cwd));
    const repositories = gitRemote === undefined ? undefined : [normalizeRemoteUrl(gitRemote)];
    const thread = await this.setThread(threadId, EMPTY_CONTENT, {
      name: path.basename(cwd),
      paths: [cwd],
      ...(repositories === undefined ? {} : { repositories }),
    });
    return { threadId, created: true, thread };
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
    const mergedDescription = mergeThreadDescription(
      readNonEmptyString(target.frontmatter.description) ?? EMPTY_CONTENT,
      sourceId,
      readNonEmptyString(source.frontmatter.description) ?? EMPTY_CONTENT,
    );

    await this.updateThread(targetId, undefined, {
      paths: mergedPaths.length > 0 ? mergedPaths : undefined,
      goals: mergedGoals.length > 0 ? mergedGoals : undefined,
      related_threads: mergedRelated.length > 0 ? mergedRelated : undefined,
      description: mergedDescription,
    });

    const date = new Date().toISOString().slice(0, ISO_DATE_LENGTH);
    await this.updateThread(
      sourceId,
      `Merged into [[${targetId}]] on ${date}. All memories re-tagged to target thread.`,
      { status: ThreadStatus.Closed },
    );

    return { retaggedCount: sourceMemos.length };
  }
}

function describeAlternateCandidates(
  matches: ThreadMatch[],
  bestId: string,
): ResolvedThreadCandidate[] {
  const candidates: ResolvedThreadCandidate[] = [];
  for (const match of matches) {
    const threadId = readNonEmptyString(match.thread.frontmatter.thread_id);
    if (threadId === null || threadId === bestId) {
      continue;
    }
    const reason: 'remote' | 'path' = match.remoteMatched && match.pathScore === null
      ? 'remote'
      : 'path';
    candidates.push({
      threadId,
      name: readNonEmptyString(match.thread.frontmatter.name) ?? threadId,
      reason,
    });
  }
  return candidates;
}
