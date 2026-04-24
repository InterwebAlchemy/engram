import * as path from 'node:path';
import { argv } from 'node:process';

const REPO_ROOT_SEGMENTS_UP = '../../..';

export function resolveRuntimeDirFromEntrypoint(): string {
  const entryPath = argv.at(1);
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    return process.cwd();
  }
  return path.dirname(path.resolve(entryPath));
}

export function resolveRepoRootFromEntrypoint(): string {
  return path.resolve(resolveRuntimeDirFromEntrypoint(), REPO_ROOT_SEGMENTS_UP);
}
