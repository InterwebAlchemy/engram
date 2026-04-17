import * as path from 'node:path';
import type { FileSystemAdapter } from './adapters/types';
import { SOUL_DOCUMENT_SLUG } from './types';
import type { ContextSection, MemoryType, TokenBudget } from './types';
import { VaultNote } from './vault';
import { ContextBuilder } from './context';
import { summarizeThread } from './memory-helpers';
import {
  addCoreContextSections,
  addQueryContextSections,
  addRememberedContextSections,
  partitionContextNotes,
} from './context-helpers';

const GLOBAL_INBOX_PRIORITY = 98;
const THREAD_PRIORITY = 100;
const THREAD_INBOX_PRIORITY = 95;
const REMEMBERED_PRIORITY = 70;
const CORE_PRIORITY = 90;
const CORE_SUMMARY_TOKEN_THRESHOLD = 200;
const DEFAULT_PRIORITY_BASE = 40;
const DEFAULT_PRIORITY_RANGE = 20;
const FALLBACK_REMEMBERED_PRIORITY = 65;

interface MemoryContextOperationDependencies {
  adapter: FileSystemAdapter;
  memoryDir: () => string;
  memoryTypeDir: (type: MemoryType | string) => string;
  getGlobalInboxSummary: (threadId?: string) => Promise<string | null>;
  getThread: (threadId: string) => Promise<VaultNote | null>;
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
    const { coreNotes, rememberedNotes, defaultNotes } = partitionContextNotes(valid, soulPath, threadId);

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
    } else {
      addRememberedContextSections(builder, rememberedNotes, this.deps.contextLabelFor, REMEMBERED_PRIORITY);
    }

    return builder.selectSections(budget.max);
  }
}
