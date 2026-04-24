import test from 'node:test';
import assert from 'node:assert/strict';
import { pickBestThreadMatch, rankThreadMatches } from './thread-helpers.js';
import { ThreadStatus } from './types.js';
import type { VaultNote } from './vault.js';
import type { NoteFrontmatter } from './types.js';

function makeThread(overrides: {
  threadId?: string;
  paths?: string[];
  repositories?: string[];
  status?: ThreadStatus;
}): VaultNote {
  const now = new Date().toISOString();
  return {
    path: `/vault/threads/${overrides.threadId ?? 'test'}.md`,
    content: '',
    frontmatter: {
      type: 'thread',
      thread_id: overrides.threadId ?? 'test',
      name: overrides.threadId ?? 'test',
      status: overrides.status ?? ThreadStatus.Active,
      created: now,
      updated: now,
      ...(overrides.paths !== undefined ? { paths: overrides.paths } : {}),
      ...(overrides.repositories !== undefined ? { repositories: overrides.repositories } : {}),
    } as NoteFrontmatter,
    updateFrontmatter() {},
    serialize() { return ''; },
    async save() { await Promise.resolve(); },
  } as unknown as VaultNote;
}

test('pickBestThreadMatch returns null when nothing overlaps', () => {
  const threads = [makeThread({ threadId: 'other', paths: ['/opt/other'] })];
  assert.equal(pickBestThreadMatch(threads, '/home/user/project'), null);
});

test('pickBestThreadMatch picks thread whose path contains cwd', () => {
  const threads = [
    makeThread({ threadId: 'outer', paths: ['/home/user'] }),
    makeThread({ threadId: 'inner', paths: ['/home/user/project'] }),
  ];
  const best = pickBestThreadMatch(threads, '/home/user/project/src');
  assert.equal(best?.frontmatter.thread_id, 'inner');
});

test('pickBestThreadMatch falls back to remote match when no path overlaps', () => {
  const threads = [
    makeThread({ threadId: 'other', paths: ['/opt/other'] }),
    makeThread({
      threadId: 'remote-match',
      paths: ['/old/location'],
      repositories: ['git@github.com:user/repo.git'],
    }),
  ];
  const best = pickBestThreadMatch(
    threads,
    '/home/user/project',
    'https://github.com/user/repo',
  );
  assert.equal(best?.frontmatter.thread_id, 'remote-match');
});

test('pickBestThreadMatch prefers path match over remote-only match', () => {
  const threads = [
    makeThread({
      threadId: 'remote-only',
      paths: ['/opt/other'],
      repositories: ['git@github.com:user/repo.git'],
    }),
    makeThread({ threadId: 'path-match', paths: ['/home/user/project'] }),
  ];
  const best = pickBestThreadMatch(
    threads,
    '/home/user/project',
    'git@github.com:user/repo.git',
  );
  assert.equal(best?.frontmatter.thread_id, 'path-match');
});

test('pickBestThreadMatch prefers active status over paused when scores equal', () => {
  const threads = [
    makeThread({
      threadId: 'paused',
      paths: ['/home/user/project'],
      status: ThreadStatus.Paused,
    }),
    makeThread({
      threadId: 'active',
      paths: ['/home/user/project'],
      status: ThreadStatus.Active,
    }),
  ];
  const best = pickBestThreadMatch(threads, '/home/user/project');
  assert.equal(best?.frontmatter.thread_id, 'active');
});

test('pickBestThreadMatch matches ssh and https remote forms equivalently', () => {
  const threads = [
    makeThread({
      threadId: 'repo',
      paths: [],
      repositories: ['git@github.com:user/repo.git'],
    }),
  ];
  const best = pickBestThreadMatch(
    threads,
    '/unrelated/cwd',
    'https://github.com/user/repo',
  );
  assert.equal(best?.frontmatter.thread_id, 'repo');
});

test('rankThreadMatches excludes threads with neither path nor remote match', () => {
  const threads = [
    makeThread({ threadId: 'unrelated', paths: ['/opt/other'] }),
    makeThread({ threadId: 'path', paths: ['/home/user/project'] }),
    makeThread({
      threadId: 'remote',
      paths: ['/opt/other'],
      repositories: ['git@github.com:user/repo.git'],
    }),
  ];
  const matches = rankThreadMatches(
    threads,
    '/home/user/project/src',
    'https://github.com/user/repo',
  );
  const ids = matches.map((m) => m.thread.frontmatter.thread_id).sort();
  assert.deepEqual(ids, ['path', 'remote']);
});

test('rankThreadMatches marks remote-only vs path-based matches', () => {
  const threads = [
    makeThread({ threadId: 'path', paths: ['/home/user/project'] }),
    makeThread({
      threadId: 'remote',
      paths: ['/old/location'],
      repositories: ['git@github.com:user/repo.git'],
    }),
  ];
  const matches = rankThreadMatches(
    threads,
    '/home/user/project',
    'https://github.com/user/repo',
  );
  const byId = new Map(matches.map((m) => [m.thread.frontmatter.thread_id, m]));
  assert.equal(byId.get('path')?.pathScore !== null, true);
  assert.equal(byId.get('remote')?.pathScore, null);
  assert.equal(byId.get('remote')?.remoteMatched, true);
});
