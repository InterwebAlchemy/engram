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
  private readonly vaultBasePath: string;

  constructor(private app: App) {
    // Obsidian's vault APIs use vault-relative paths, but MemoryManager
    // constructs absolute paths via path.resolve(basePath, …). We capture
    // the vault root here so we can strip it before every vault API call.
    this.vaultBasePath =
      (app.vault.adapter as unknown as { basePath?: string }).basePath ?? '';
  }

  /**
   * Convert an absolute filesystem path to a vault-relative path.
   * If the path is already relative (no leading slash / no basePath match)
   * it is returned as-is after normalization.
   */
  private toVaultPath(filePath: string): string {
    if (this.vaultBasePath && filePath.startsWith(this.vaultBasePath)) {
      return normalizePath(filePath.slice(this.vaultBasePath.length).replace(/^[\\/]/, ''));
    }
    return normalizePath(filePath);
  }

  async read(filePath: string): Promise<string> {
    const vaultPath = this.toVaultPath(filePath);
    const file = this.app.vault.getAbstractFileByPath(vaultPath);
    if (file instanceof TFile) {
      return this.app.vault.read(file);
    }
    throw new Error(`File not found: ${vaultPath}`);
  }

  async write(filePath: string, content: string): Promise<void> {
    const vaultPath = this.toVaultPath(filePath);

    // Ensure parent directory exists
    const dir = vaultPath.substring(0, vaultPath.lastIndexOf('/'));
    if (dir) {
      await this.mkdirRecursive(dir);
    }

    const existing = this.app.vault.getAbstractFileByPath(vaultPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(vaultPath, content);
    }
  }

  async exists(filePath: string): Promise<boolean> {
    return this.app.vault.getAbstractFileByPath(this.toVaultPath(filePath)) !== null;
  }

  async list(directory: string): Promise<string[]> {
    const results: string[] = [];
    const vaultPath = this.toVaultPath(directory);
    const dir = this.app.vault.getAbstractFileByPath(vaultPath);
    if (dir instanceof TFolder) {
      this.collectMarkdownFiles(dir, results);
    }
    return results;
  }

  async search(query: string, directory?: string): Promise<SearchResult[]> {
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

  async mkdir(filePath: string): Promise<void> {
    await this.mkdirRecursive(this.toVaultPath(filePath));
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private collectMarkdownFiles(folder: TFolder, out: string[]): void {
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === 'md') {
        // Return absolute paths so MemoryManager's path.resolve comparisons work
        // correctly. toVaultPath() will strip the prefix again on the way back in.
        out.push(this.vaultBasePath ? `${this.vaultBasePath}/${child.path}` : child.path);
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
