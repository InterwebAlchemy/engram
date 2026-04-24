import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import type { FileSystemAdapter } from './types.js';
import type { SearchResult } from '../types.js';
import { escapeRegex, tokenizeQuery } from '../utils.js';

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

export class NodeAdapter implements FileSystemAdapter {
  private readonly fs = fs;

  private readonly path = path;

  private readonly markdownExtension = '.md';

  async read(filePath: string): Promise<string> {
    return await this.fs.readFile(filePath, 'utf-8');
  }

  async write(filePath: string, content: string): Promise<void> {
    await this.fs.mkdir(this.path.dirname(filePath), { recursive: true });
    await this.fs.writeFile(filePath, content, 'utf-8');
  }

  async process(filePath: string, fn: (content: string) => string): Promise<string> {
    await this.fs.mkdir(this.path.dirname(filePath), { recursive: true });

    let existing = '';
    try {
      existing = await this.fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if (!isErrnoException(error) || error.code !== 'ENOENT') {
        throw error;
      }
    }

    const nextContent = fn(existing);
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

    try {
      await this.fs.writeFile(tempPath, nextContent, 'utf-8');
      await this.fs.rename(tempPath, filePath);
    } catch (error) {
      await this.fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }

    return nextContent;
  }

  async delete(filePath: string): Promise<void> {
    await this.fs.unlink(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await this.fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(directory: string): Promise<string[]> {
    return await this.walkDir(directory);
  }

  async search(query: string, directory?: string): Promise<SearchResult[]> {
    const dir = directory ?? '.';
    const files = await this.walkDir(dir);
    const results: SearchResult[] = [];

    const tokens = tokenizeQuery(query);

    // Fall back to literal match if no usable tokens
    const patterns =
      tokens.length > 0
        ? tokens.map((token) => new RegExp(escapeRegex(token), 'giu'))
        : [new RegExp(escapeRegex(query), 'giu')];

    await Promise.all(
      files.map(async (filePath) => {
        try {
          const content = await this.read(filePath);
          let score = 0;
          for (const pattern of patterns) {
            const matches = content.match(pattern);
            if (matches !== null) score += matches.length;
          }
          if (score > 0) {
            results.push({ path: filePath, content, score });
          }
        } catch {
          // skip unreadable files
        }
      }),
    );

    return results.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }

  async mkdir(dirPath: string): Promise<void> {
    await this.fs.mkdir(dirPath, { recursive: true });
  }

  private async walkDir(directory: string): Promise<string[]> {
    const results: string[] = [];
    try {
      const entries: Dirent[] = await this.fs.readdir(directory, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const fullPath = this.path.join(directory, entry.name);
          if (entry.isDirectory()) {
            const sub = await this.walkDir(fullPath);
            results.push(...sub);
          } else if (
            entry.isFile() &&
            entry.name.endsWith(this.markdownExtension)
          ) {
            results.push(fullPath);
          }
        }),
      );
    } catch {
      return results;
    }

    return results;
  }
}
