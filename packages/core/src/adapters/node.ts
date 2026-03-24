import * as fs from 'fs/promises';
import * as path from 'path';
import type { FileSystemAdapter } from './types';
import type { SearchResult } from '../types';
import { escapeRegex } from '../utils';

export class NodeAdapter implements FileSystemAdapter {
  async read(filePath: string): Promise<string> {
    return fs.readFile(filePath, 'utf-8');
  }

  async write(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
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
    const pattern = new RegExp(escapeRegex(query), 'gi');

    await Promise.all(
      files.map(async (filePath) => {
        try {
          const content = await this.read(filePath);
          const matches = content.match(pattern);
          if (matches) {
            results.push({ path: filePath, content, score: matches.length });
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
