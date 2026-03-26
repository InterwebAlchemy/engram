import type { SearchResult } from '../types';

export interface FileSystemAdapter {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(directory: string): Promise<string[]>;
  search(query: string, directory?: string): Promise<SearchResult[]>;
  mkdir(path: string): Promise<void>;
}
