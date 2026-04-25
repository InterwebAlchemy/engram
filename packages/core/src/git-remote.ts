import { execFileSync } from 'node:child_process';

export type GitRemoteDetector = (cwd: string) => string | undefined;

const GIT_TIMEOUT_MS = 1_000;

export const detectGitRemote: GitRemoteDetector = (cwd: string): string | undefined => {
  try {
    const raw = execFileSync('git', ['-C', cwd, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Canonicalize a git remote URL so the common SSH/HTTPS variants compare equal.
 * Examples:
 *   git@github.com:user/repo.git      -> github.com/user/repo
 *   https://github.com/user/repo.git  -> github.com/user/repo
 *   ssh://git@github.com/user/repo    -> github.com/user/repo
 */
const SCP_REMOTE_PATTERN = /^[^@\s]+@(?<host>[^:]+):(?<path>.+)$/u;

export function normalizeRemoteUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return '';
  }

  const scpMatch = SCP_REMOTE_PATTERN.exec(trimmed);
  const bare = scpMatch === null
    ? trimmed.replace(/^[a-z]+:\/\//iu, '').replace(/^[^@]+@/u, '')
    : `${scpMatch.groups?.host ?? ''}/${scpMatch.groups?.path ?? ''}`;

  return bare.replace(/\/+$/u, '').replace(/\.git$/u, '').toLowerCase();
}
