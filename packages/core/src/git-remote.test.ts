import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRemoteUrl } from './git-remote.js';

test('normalizes SSH-style remote', () => {
  assert.equal(
    normalizeRemoteUrl('git@github.com:user/repo.git'),
    'github.com/user/repo',
  );
});

test('normalizes HTTPS-style remote with .git suffix', () => {
  assert.equal(
    normalizeRemoteUrl('https://github.com/user/repo.git'),
    'github.com/user/repo',
  );
});

test('normalizes HTTPS-style remote without .git suffix', () => {
  assert.equal(
    normalizeRemoteUrl('https://github.com/user/repo'),
    'github.com/user/repo',
  );
});

test('normalizes ssh:// protocol remote', () => {
  assert.equal(
    normalizeRemoteUrl('ssh://git@github.com/user/repo.git'),
    'github.com/user/repo',
  );
});

test('normalizes trailing slash and mixed case', () => {
  assert.equal(
    normalizeRemoteUrl('https://GITHUB.com/User/Repo.git/'),
    'github.com/user/repo',
  );
});

test('empty input returns empty string', () => {
  assert.equal(normalizeRemoteUrl(''), '');
  assert.equal(normalizeRemoteUrl('   '), '');
});

test('ssh and https forms compare equal after normalization', () => {
  assert.equal(
    normalizeRemoteUrl('git@github.com:user/repo.git'),
    normalizeRemoteUrl('https://github.com/user/repo'),
  );
});
