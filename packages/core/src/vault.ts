import * as yaml from 'yaml';
import type { FileSystemAdapter } from './adapters/types';
import { MemoryState, MemoryType } from './types';
import type { NoteFrontmatter } from './types';

const DELIMITER = '---';

export class VaultNote {
  constructor(
    public path: string,
    public frontmatter: NoteFrontmatter,
    public content: string,
  ) {}

  // ─── Static factory methods ───────────────────────────────────────────────

  static async read(adapter: FileSystemAdapter, filePath: string): Promise<VaultNote> {
    const raw = await adapter.read(filePath);
    return VaultNote.parse(filePath, raw);
  }

  static parse(filePath: string, raw: string): VaultNote {
    const lines = raw.split('\n');

    if (lines[0]?.trim() !== DELIMITER) {
      return new VaultNote(filePath, VaultNote.defaultFrontmatter(), raw.trim());
    }

    const closeIdx = lines.slice(1).findIndex((l) => l.trim() === DELIMITER);
    if (closeIdx === -1) {
      return new VaultNote(filePath, VaultNote.defaultFrontmatter(), raw.trim());
    }

    const fmRaw = lines.slice(1, closeIdx + 1).join('\n');
    const body = lines.slice(closeIdx + 2).join('\n').trim();

    let frontmatter: NoteFrontmatter;
    try {
      const parsed = yaml.parse(fmRaw) as Record<string, unknown>;
      frontmatter = {
        ...parsed,
        memory_state: (parsed.memory_state as MemoryState) ?? MemoryState.Default,
      } as NoteFrontmatter;
    } catch {
      frontmatter = VaultNote.defaultFrontmatter();
    }

    return new VaultNote(filePath, frontmatter, body);
  }

  static async create(
    adapter: FileSystemAdapter,
    filePath: string,
    frontmatter: NoteFrontmatter,
    content: string,
  ): Promise<VaultNote> {
    const note = new VaultNote(filePath, frontmatter, content);
    await note.save(adapter);
    return note;
  }

  // ─── Instance methods ─────────────────────────────────────────────────────

  updateFrontmatter(updates: Partial<NoteFrontmatter>): void {
    Object.assign(this.frontmatter, updates);
    this.frontmatter.updated = new Date().toISOString();
  }

  appendContent(text: string): void {
    this.content = this.content ? `${this.content}\n\n${text}` : text;
  }

  async save(adapter: FileSystemAdapter): Promise<void> {
    this.frontmatter.updated = new Date().toISOString();
    await adapter.write(this.path, this.serialize());
  }

  serialize(): string {
    const fm = yaml.stringify(this.frontmatter, { lineWidth: 0 }).trimEnd();
    return `---\n${fm}\n---\n\n${this.content}`;
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  private static defaultFrontmatter(): NoteFrontmatter {
    const now = new Date().toISOString();
    return {
      type: MemoryType.Fact,
      created: now,
      updated: now,
      memory_state: MemoryState.Default,
    };
  }
}
