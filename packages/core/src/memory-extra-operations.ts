import * as path from 'node:path';
import type { FileSystemAdapter } from './adapters/types';
import { MemoryState, MemoryType, SOUL_DOCUMENT_SLUG } from './types';
import type { ConversationFrontmatter, Message, NoteFrontmatter } from './types';
import { VaultNote } from './vault';
import { Conversation } from './conversation';
import { datePath, slugify } from './utils';

const HOURS_PER_DAY = 24;
const MINUTES_PER_HOUR = 60;
const SECONDS_PER_MINUTE = 60;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY =
  HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MILLISECONDS_PER_SECOND;

interface MemoryExtraOperationDependencies {
  assertWriteAllowed: (filePath: string) => void;
  adapter: FileSystemAdapter;
  archiveDir: () => string;
  memoryTypeDir: (type: MemoryType | string) => string;
  memoryDir: () => string;
  skillsDir: () => string;
  writeRoot: string;
  listMemories: (filters?: { state?: MemoryState }) => Promise<VaultNote[]>;
  conversationDir: (dateStr?: string) => string;
}

export class MemoryExtraOperations {
  constructor(private readonly deps: MemoryExtraOperationDependencies) {}

  async getSoulDocument(): Promise<VaultNote | null> {
    const filePath = path.join(this.deps.memoryDir(), `${SOUL_DOCUMENT_SLUG}.md`);
    return await VaultNote.read(this.deps.adapter, filePath).catch(() => null);
  }

  async setSoulDocument(content: string): Promise<VaultNote> {
    const dir = this.deps.memoryDir();
    const filePath = path.join(dir, `${SOUL_DOCUMENT_SLUG}.md`);

    this.deps.assertWriteAllowed(filePath);
    await this.deps.adapter.mkdir(dir);

    const existing = await VaultNote.read(this.deps.adapter, filePath).catch(() => null);
    const now = new Date().toISOString();

    // If content includes frontmatter, parse it out so the body is clean
    // and merge the incoming frontmatter fields over the defaults.
    const parsed = VaultNote.parse(filePath, content);
    const hasIncomingFrontmatter = content.trimStart().startsWith('---');
    const incomingFm = hasIncomingFrontmatter ? parsed.frontmatter : {};
    const body = hasIncomingFrontmatter ? parsed.content : content;

    const frontmatter: NoteFrontmatter = {
      ...existing?.frontmatter,
      ...incomingFm,
      type: MemoryType.Reflection,
      created: existing?.frontmatter.created ?? now,
      updated: now,
      memory_state: MemoryState.Core,
    };

    return await VaultNote.create(this.deps.adapter, filePath, frontmatter, body);
  }

  async storeSkill(slug: string, content: string, tags: string[] = []): Promise<VaultNote> {
    const dir = this.deps.skillsDir();
    const filePath = path.join(dir, `${slug}.md`);

    this.deps.assertWriteAllowed(filePath);
    await this.deps.adapter.mkdir(dir);

    const existing = await VaultNote.read(this.deps.adapter, filePath).catch(() => null);
    const now = new Date().toISOString();
    const frontmatter: NoteFrontmatter = {
      type: MemoryType.Skill,
      created: existing?.frontmatter.created ?? now,
      updated: now,
      memory_state: MemoryState.Core,
      tags,
    };

    return await VaultNote.create(this.deps.adapter, filePath, frontmatter, content);
  }

  async getSkill(slug: string): Promise<VaultNote | null> {
    const filePath = path.join(this.deps.skillsDir(), `${slug}.md`);
    return await VaultNote.read(this.deps.adapter, filePath).catch(() => null);
  }

  async listSkills(): Promise<VaultNote[]> {
    const dir = this.deps.skillsDir();
    const files = await this.deps.adapter.list(dir).catch(() => [] as string[]);
    const notes = await Promise.all(
      files.map(async (filePath) => await VaultNote.read(this.deps.adapter, filePath).catch(() => null)),
    );
    return notes.filter((note): note is VaultNote => note !== null);
  }

  async archiveForgotten(olderThanDays?: number): Promise<string[]> {
    const forgotten = await this.deps.listMemories({ state: MemoryState.Forgotten });
    const cutoff = olderThanDays === undefined
      ? null
      : new Date(Date.now() - olderThanDays * MILLISECONDS_PER_DAY);
    const toArchive = cutoff === null
      ? forgotten
      : forgotten.filter((note) => new Date(note.frontmatter.updated) <= cutoff);

    const archived: string[] = [];
    await Promise.all(
      toArchive.map(async (note) => {
        const relative = path.relative(this.deps.writeRoot, note.path);
        const destination = path.join(this.deps.archiveDir(), relative);
        this.deps.assertWriteAllowed(note.path);
        await this.deps.adapter.mkdir(path.dirname(destination));
        await this.deps.adapter.write(destination, note.serialize());
        await this.deps.adapter.delete(note.path);
        archived.push(destination);
      }),
    );

    return archived;
  }

  async saveConversation(conversation: Conversation, slug?: string): Promise<VaultNote> {
    const date = datePath(new Date(conversation.frontmatter.created));
    const fileSlug = slug ?? `conversation-${Date.now()}`;
    const dir = this.deps.conversationDir(date);
    const filePath = path.join(dir, `${fileSlug}.md`);

    this.deps.assertWriteAllowed(filePath);
    await this.deps.adapter.mkdir(dir);
    await this.deps.adapter.write(filePath, conversation.toMarkdown());
    return await VaultNote.read(this.deps.adapter, filePath);
  }

  async storeConversation(
    messages: Array<Pick<Message, 'role' | 'content'>>,
    summary?: string,
    tags: string[] = [],
    slug?: string,
  ): Promise<VaultNote> {
    const now = new Date().toISOString();
    const fullMessages: Message[] = messages.map((message) => ({
      role: message.role,
      content: message.content,
      timestamp: new Date(),
      memoryState: MemoryState.Default,
    }));
    const frontmatter: ConversationFrontmatter = {
      type: 'conversation',
      created: now,
      updated: now,
      providers: [],
      tags,
      summary,
      message_count: fullMessages.length,
    };

    const conversation = new Conversation(fullMessages, frontmatter);
    const fileSlug = slug ?? (
      typeof summary === 'string' && summary.length > 0
        ? slugify(summary)
        : undefined
    );
    return await this.saveConversation(conversation, fileSlug);
  }
}
