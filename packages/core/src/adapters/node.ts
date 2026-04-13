import * as fs from 'fs/promises';
import * as path from 'path';
import type { FileSystemAdapter } from './types';
import type { SearchResult } from '../types';
import { escapeRegex, tokenizeQuery } from '../utils';

export class NodeAdapter implements FileSystemAdapter {
  async read(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  async write(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  async process(filePath: string, fn: (content: string) => string): Promise<string> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });

    let existing = '';
    try {
      existing = await fs.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }

    const nextContent = fn(existing);
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

    try {
      await fs.writeFile(tempPath, nextContent, 'utf-8');
      await fs.rename(tempPath, filePath);
    } catch (error) {
      await fs.unlink(tempPath).catch(() => undefined);
      throw error;
    }

    return nextContent;
  }

  async delete(filePath: string): Promise<void> {
    await fs.unlink(filePath);
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(directory: string): Promise<string[]> {
    return this.walkDir(directory);
  }

  async search(query: string, directory?: string): Promise<SearchResult[]> {
    const dir = directory ?? '.';
    const files = await this.walkDir(dir);
    const results: SearchResult[] = [];

    const tokens = tokenizeQuery(query);

    // Fall back to literal match if no usable tokens
    const patterns =
      tokens.length > 0
        ? tokens.map((t) => new RegExp(escapeRegex(t), 'gi'))
        : [new RegExp(escapeRegex(query), 'gi')];

    await Promise.all(
      files.map(async (filePath) => {
        try {
          const content = await this.read(filePath);
          let score = 0;
          for (const pattern of patterns) {
            const matches = content.match(pattern);
            if (matches) score += matches.length;
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
    await fs.mkdir(dirPath, { recursive: true });
  }

  private async walkDir(directory: string): Promise<string[]> {
    const results: string[] = [];
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return results;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          const sub = await this.walkDir(fullPath);
          results.push(...sub);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(fullPath);
        }
      }),
    );
    return results;
  }
}
