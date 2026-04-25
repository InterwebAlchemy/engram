import { readFileSync } from 'node:fs';
import * as path from 'node:path';

export type PackageNameDetector = (cwd: string) => string[];

const MAX_ANCESTOR_DEPTH = 10;

/**
 * Walk from `cwd` up to the filesystem root, collecting every package.json
 * "name" encountered. Returns names ordered innermost-first (the most
 * specific package wins on first match when callers compare).
 */
export const detectPackageNames: PackageNameDetector = (cwd: string): string[] => {
  const names: string[] = [];
  for (const dir of walkAncestors(cwd, MAX_ANCESTOR_DEPTH)) {
    const name = readPackageName(dir);
    if (name !== undefined) {
      names.push(name);
    }
  }
  return names;
};

function walkAncestors(start: string, maxDepth: number): string[] {
  const ancestors: string[] = [];
  let current = start;
  while (ancestors.length < maxDepth) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return ancestors;
}

function readPackageName(dir: string): string | undefined {
  try {
    const raw = readFileSync(path.join(dir, 'package.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) {
      return undefined;
    }
    const { name } = parsed as { name?: unknown };
    return typeof name === 'string' && name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}
