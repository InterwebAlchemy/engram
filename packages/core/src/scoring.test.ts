import test from 'node:test';
import assert from 'node:assert/strict';
import { KeywordSearchProvider } from './scoring.js';
import type { VaultNote } from './vault.js';
import type { NoteFrontmatter } from './types.js';

function makeNote(overrides: {
  path?: string;
  content?: string;
  summary?: string;
  tags?: string[];
  state?: string;
  updated?: string;
}): VaultNote {
  const now = new Date().toISOString();
  return {
    path: overrides.path ?? '/vault/memory/facts/test.md',
    content: overrides.content ?? '',
    frontmatter: {
      type: 'fact',
      created: now,
      updated: overrides.updated ?? now,
      tags: overrides.tags ?? [],
      memory_state: overrides.state ?? 'default',
      ...(overrides.summary !== undefined ? { summary: overrides.summary } : {}),
    } as NoteFrontmatter,
    updateFrontmatter() {},
    serialize() { return ''; },
    async save() { await Promise.resolve(); },
  } as unknown as VaultNote;
}

const provider = new KeywordSearchProvider();

test('returns empty array for empty query', () => {
  const notes = [makeNote({ content: 'some content about dreams' })];
  const result = provider.rank('', notes);
  assert.equal(result.length, 0);
});

test('returns empty array for stop-word-only query', () => {
  const notes = [makeNote({ content: 'some content' })];
  const result = provider.rank('the and for', notes);
  assert.equal(result.length, 0);
});

test('scores higher when query matches summary', () => {
  const withSummary = makeNote({
    path: '/vault/memory/facts/a.md',
    content: 'The vault analysis process runs automatically before the LLM sees anything. It handles tag normalization, scratch pruning, and other deterministic cleanup steps that do not require model judgment.',
    summary: 'Dreams consolidation validated through four iterations',
  });
  const withoutSummary = makeNote({
    path: '/vault/memory/facts/b.md',
    content: 'The vault analysis process runs automatically before the LLM sees anything. It handles tag normalization, scratch pruning, and other deterministic cleanup steps. The dreams package was added in a prior session but has not been fully tested in production yet. Further iteration is needed on the prompt design.',
  });

  const results = provider.rank('dreams consolidation', [withSummary, withoutSummary]);
  assert.ok(results.length >= 1, 'should have at least one result');
  assert.equal(results[0].note.path, '/vault/memory/facts/a.md', 'summary-match note should rank first');
  if (results.length > 1) {
    assert.ok(results[0].score > results[1].score, 'summary match should score higher');
  }
});

test('tag matching works with namespaced tags', () => {
  const tagged = makeNote({
    path: '/vault/memory/facts/tagged.md',
    content: 'some content',
    tags: ['engram/dreams', 'engram/milestone'],
    summary: 'unrelated summary about infrastructure',
  });
  const untagged = makeNote({
    path: '/vault/memory/facts/untagged.md',
    content: 'some content about other things',
    summary: 'unrelated summary about infrastructure',
  });

  const results = provider.rank('dreams', [tagged, untagged]);
  assert.ok(results.length >= 1);
  assert.equal(results[0].note.path, '/vault/memory/facts/tagged.md');
});

test('filters out notes below score threshold', () => {
  const irrelevant = makeNote({
    content: 'completely unrelated content about cooking recipes and gardening tips',
    summary: 'cooking and gardening notes from today',
    tags: ['cooking', 'gardening'],
  });

  const results = provider.rank('dreams consolidation bootstrap', [irrelevant]);
  assert.equal(results.length, 0, 'irrelevant note should be filtered out');
});

test('recency boosts newer notes', () => {
  const recent = makeNote({
    path: '/vault/memory/facts/recent.md',
    content: 'bootstrap verification confirmed working',
    summary: 'bootstrap confirmed',
    updated: new Date().toISOString(),
  });
  const old = makeNote({
    path: '/vault/memory/facts/old.md',
    content: 'bootstrap verification confirmed working',
    summary: 'bootstrap confirmed',
    updated: new Date(Date.now() - 80 * 24 * 60 * 60 * 1000).toISOString(), // 80 days ago
  });

  const results = provider.rank('bootstrap', [recent, old]);
  assert.equal(results.length, 2);
  assert.equal(results[0].note.path, '/vault/memory/facts/recent.md', 'newer note should rank first');
  assert.ok(results[0].score > results[1].score);
});

test('results are sorted by score descending', () => {
  const high = makeNote({
    path: '/vault/memory/facts/high.md',
    content: 'dreams dreams dreams consolidation consolidation',
    summary: 'Dreams consolidation — four iterations of vault cleanup',
    tags: ['engram/dreams'],
  });
  const medium = makeNote({
    path: '/vault/memory/facts/medium.md',
    content: 'mentions dreams once in passing',
    summary: 'general project notes',
  });
  const low = makeNote({
    path: '/vault/memory/facts/low.md',
    content: 'snapshot infrastructure for vault safety',
    summary: 'snapshot tooling',
    tags: ['engram/snapshot'],
  });

  const results = provider.rank('dreams consolidation', [low, high, medium]);
  for (let i = 1; i < results.length; i++) {
    assert.ok(
      results[i - 1].score >= results[i].score,
      `results[${i - 1}].score (${results[i - 1].score}) should be >= results[${i}].score (${results[i].score})`,
    );
  }
});
