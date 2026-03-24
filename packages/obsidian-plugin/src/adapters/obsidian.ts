import { App, TFile, TFolder, normalizePath } from 'obsidian';
import type { FileSystemAdapter } from '@interwebalchemy/engram-core';
import type { SearchResult } from '@interwebalchemy/engram-core';

/**
 * FileSystemAdapter backed by Obsidian's vault API.
 *
 * Uses `app.vault` for reads/writes and `app.vault.adapter` (the raw FS layer)
 * where the higher-level API doesn't cover our needs (e.g. directory listing
 * before a folder has been indexed).
 */
export class ObsidianAdapter implements FileSystemAdapter {
  constructor(private app: App) {}

  async read(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (file instanceof TFile) {
      return this.app.vault.read(file);
    }
    throw new Error(`File not found: ${path}`);
  }

  async write(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);

    // Ensure parent directory exists
    const dir = normalized.substring(0, normalized.lastIndexOf('/'));
    if (dir) {
      await this.mkdirRecursive(dir);
    }

    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(normalized, content);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  async list(directory: string): Promise<string[]> {
    const results: string[] = [];
    const dir = this.app.vault.getAbstractFileByPath(normalizePath(directory));
    if (dir instanceof TFolder) {
      this.collectMarkdownFiles(dir, results);
    }
    return results;
  }

  async search(query: string, directory?: string): Promise<SearchResult[]> {
    // Use Obsidian's built-in search when available. Falls back to a
    // brute-force scan of markdown files in the target directory.
    const files = await this.list(directory ?? '/');
    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();

    for (const filePath of files) {
      try {
        const content = await this.read(filePath);
        if (content.toLowerCase().includes(queryLower)) {
          const pattern = new RegExp(
            query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
            'gi',
          );
          const matches = content.match(pattern);
          results.push({
            path: filePath,
            content,
            score: matches?.length ?? 1,
          });
        }
      } catch {
        // Skip unreadable files
      }
    }

    return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  async mkdir(path: string): Promise<void> {
    await this.mkdirRecursive(normalizePath(path));
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private collectMarkdownFiles(folder: TFolder, out: string[]): void {
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        out.push(child.path);
      } else if (child instanceof TFolder) {
        this.collectMarkdownFiles(child, out);
      }
    }
  }

  private async mkdirRecursive(path: string): Promise<void> {
    const parts = normalizePath(path).split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (!existing) {
        await this.app.vault.createFolder(current);
      }
    }
  }
}
