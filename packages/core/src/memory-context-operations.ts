import * as path from 'node:path';
import type { FileSystemAdapter } from './adapters/types.js';
import { SOUL_DOCUMENT_SLUG } from './types.js';
import type { ContextSection, MemoryType, TokenBudget } from './types.js';
import { VaultNote } from './vault.js';
import { ContextBuilder } from './context.js';
import { readNonEmptyString, summarizeThread } from './memory-helpers.js';
import {
  addCoreContextSections,
  addQueryContextSections,
  addRememberedContextSections,
  aggregateCrossThreadCandidates,
  formatRelatedThreadsSection,
  partitionContextNotes,
} from './context-helpers.js';

const GLOBAL_INBOX_PRIORITY = 98;
const THREAD_PRIORITY = 100;
const THREAD_INBOX_PRIORITY = 95;
const RELATED_THREADS_PRIORITY = 80;
const REMEMBERED_PRIORITY = 70;
const CORE_PRIORITY = 90;
const CORE_SUMMARY_TOKEN_THRESHOLD = 200;
const DEFAULT_PRIORITY_BASE = 40;
const DEFAULT_PRIORITY_RANGE = 20;
const FALLBACK_REMEMBERED_PRIORITY = 65;
const MAX_RELATED_THREADS = 3;

interface MemoryContextOperationDependencies {
  adapter: FileSystemAdapter;
  memoryDir: () => string;
  memoryTypeDir: (type: MemoryType | string) => string;
  getGlobalInboxSummary: (threadId?: string) => Promise<string | null>;
  getThread: (threadId: string) => Promise<VaultNote | null>;
  listThreads: () => Promise<VaultNote[]>;
  getThreadInboxSummary: (threadId: string) => Promise<string | null>;
  contextLabelFor: (note: VaultNote) => string;
  searchProvider: {
    rank: (query: string, notes: VaultNote[]) => Array<{ note: VaultNote; score: number }>;
  };
}

export class MemoryContextOperations {
  constructor(private readonly deps: MemoryContextOperationDependencies) {}

  private async addThreadContextSections(builder: ContextBuilder, threadId?: string): Promise<void> {
    const globalInboxSummary = await this.deps.getGlobalInboxSummary(threadId);
    if (globalInboxSummary !== null) {
      builder.addSection('inbox:global', globalInboxSummary, GLOBAL_INBOX_PRIORITY);
    }

    if (threadId === undefined) {
      return;
    }

    const thread = await this.deps.getThread(threadId);
    if (thread !== null) {
      builder.addSection(`thread:${threadId}`, summarizeThread(thread), THREAD_PRIORITY);
    }

    const inboxSummary = await this.deps.getThreadInboxSummary(threadId);
    if (inboxSummary !== null) {
      builder.addSection(`thread-inbox:${threadId}`, inboxSummary, THREAD_INBOX_PRIORITY);
    }
  }

  async getContext(query: string, budget: TokenBudget, threadId?: string): Promise<ContextSection[]> {
    const allFiles = await this.deps.adapter.list(this.deps.memoryDir());
    const allNotes = await Promise.all(
      allFiles.map(async (filePath) => await VaultNote.read(this.deps.adapter, filePath).catch(() => null)),
    );
    const valid = allNotes.filter((note): note is VaultNote => note !== null);

    const soulPath = path.join(this.deps.memoryDir(), `${SOUL_DOCUMENT_SLUG}.md`);
    const {
      coreNotes,
      rememberedNotes,
      defaultNotes,
      crossThreadNotes,
    } = partitionContextNotes(valid, soulPath, threadId);

    const builder = new ContextBuilder();
    await this.addThreadContextSections(builder, threadId);
    addCoreContextSections(builder, coreNotes, this.deps.contextLabelFor, {
      corePriority: CORE_PRIORITY,
      coreSummaryTokenThreshold: CORE_SUMMARY_TOKEN_THRESHOLD,
    });

    if (query.trim().length > 0) {
      addQueryContextSections(builder, {
        query,
        rememberedNotes,
        defaultNotes,
        searchProvider: this.deps.searchProvider,
        contextLabelFor: this.deps.contextLabelFor,
        rememberedPriority: REMEMBERED_PRIORITY,
        defaultPriorityBase: DEFAULT_PRIORITY_BASE,
        defaultPriorityRange: DEFAULT_PRIORITY_RANGE,
        fallbackRememberedPriority: FALLBACK_REMEMBERED_PRIORITY,
      });
      if (threadId !== undefined) {
        await this.addRelatedThreadsSection(builder, query, crossThreadNotes, threadId);
      }
    } else {
      addRememberedContextSections(builder, rememberedNotes, this.deps.contextLabelFor, REMEMBERED_PRIORITY);
    }

    return builder.selectSections(budget.max);
  }

  private async addRelatedThreadsSection(
    builder: ContextBuilder,
    query: string,
    crossThreadNotes: VaultNote[],
    activeThreadId: string,
  ): Promise<void> {
    const allThreads = await this.deps.listThreads();
    const otherThreads = allThreads.filter(
      (thread) => readNonEmptyString(thread.frontmatter.thread_id) !== activeThreadId,
    );

    const candidates = aggregateCrossThreadCandidates({
      query,
      crossThreadNotes,
      otherThreads,
      searchProvider: this.deps.searchProvider,
      maxThreads: MAX_RELATED_THREADS,
    });
    if (candidates.length === 0) {
      return;
    }

    const threadNames = new Map<string, string>();
    for (const thread of otherThreads) {
      const id = readNonEmptyString(thread.frontmatter.thread_id);
      const name = readNonEmptyString(thread.frontmatter.name);
      if (id !== null && name !== null) {
        threadNames.set(id, name);
      }
    }

    builder.addSection(
      `related-threads:${activeThreadId}`,
      formatRelatedThreadsSection(candidates, threadNames),
      RELATED_THREADS_PRIORITY,
    );
  }
}
