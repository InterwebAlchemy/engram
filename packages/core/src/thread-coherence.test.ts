import test from 'node:test';
import assert from 'node:assert/strict';
import { assessThreadCoherence } from './thread-coherence.js';
import { VaultNote } from './vault.js';

interface ThreadFixtureOptions {
  threadId: string;
  name?: string;
  description?: string;
  goals?: string[];
  aliases?: string[];
  related_threads?: string[];
  repositories?: string[];
  packages?: string[];
}

function makeThread(opts: ThreadFixtureOptions, body = ''): VaultNote {
  return new VaultNote(
    `engram/threads/${opts.threadId}.md`,
    {
      type: 'thread',
      thread_id: opts.threadId,
      name: opts.name ?? opts.threadId,
      status: 'active',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
      ...(opts.description === undefined ? {} : { description: opts.description }),
      ...(opts.goals === undefined ? {} : { goals: opts.goals }),
      ...(opts.aliases === undefined ? {} : { aliases: opts.aliases }),
      ...(opts.related_threads === undefined ? {} : { related_threads: opts.related_threads }),
      ...(opts.repositories === undefined ? {} : { repositories: opts.repositories }),
      ...(opts.packages === undefined ? {} : { packages: opts.packages }),
    },
    body,
  );
}

test('flags content prominently referencing a different known thread', () => {
  const oara = makeThread({
    threadId: 'obsidian-ai-research-assistant',
    name: 'OARA — Plugin Modernization',
    description: 'Port settings UI and providers from the Engram plugin.',
    goals: ['Migrate settings UI', 'Migrate providers'],
  });
  const engram = makeThread({
    threadId: 'engram-core',
    name: 'Engram core',
    description: 'Core memory library.',
  });

  const newBody = [
    '## Context',
    'Heavy refactor planned across engram-core to align provider abstraction.',
    '',
    'See engram-core for the upstream API. Most of the work touches engram-core internals.',
  ].join('\n');

  const warnings = assessThreadCoherence(oara, newBody, [engram]);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'known-thread-mention');
  assert.match(warnings[0].message, /engram-core/);
});

test('flags content referencing an unknown project slug as a planned-thread candidate', () => {
  const oara = makeThread({
    threadId: 'obsidian-ai-research-assistant',
    name: 'OARA — Plugin Modernization',
    description: 'Port settings UI and providers from the Engram plugin.',
  });

  const newBody = [
    '## Context',
    'Planned thread to revive the abandoned model-metadata-central repo.',
    '',
    'Goals: add models, ship typescript package, wire CI.',
  ].join('\n');

  const warnings = assessThreadCoherence(oara, newBody, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'unknown-slug-mention');
  assert.equal(warnings[0].slug, 'model-metadata-central');
  assert.match(warnings[0].message, /planned Thread/);
});

test('does not flag a slug that appears only casually (single mention, deep in body)', () => {
  const thread = makeThread({
    threadId: 'engram-core',
    name: 'Engram core',
    description: 'Core memory library.',
  });

  const filler = 'Lorem ipsum dolor sit amet. '.repeat(40);
  const newBody = [
    '## Context',
    'Core library work continues.',
    '',
    filler,
    '',
    'Aside: there is a tangentially related model-metadata-central project we may consume someday.',
  ].join('\n');

  const warnings = assessThreadCoherence(thread, newBody, []);
  assert.equal(warnings.length, 0);
});

test('does not flag slugs that match the active thread identity', () => {
  const thread = makeThread({
    threadId: 'obsidian-ai-research-assistant',
    name: 'OARA',
    description: 'Modernize the obsidian-ai-research-assistant plugin.',
    repositories: ['git@github.com:InterwebAlchemy/obsidian-ai-research-assistant.git'],
  });

  const newBody = [
    '## Context',
    'Continuing modernization of obsidian-ai-research-assistant — settings and providers.',
  ].join('\n');

  const warnings = assessThreadCoherence(thread, newBody, []);
  assert.equal(warnings.length, 0);
});

test('does not flag empty content', () => {
  const thread = makeThread({ threadId: 'engram-core', name: 'Engram core' });
  assert.deepEqual(assessThreadCoherence(thread, '', []), []);
  assert.deepEqual(assessThreadCoherence(thread, '   \n\n', []), []);
});

test('flags slugs that appear in markdown headings even if mentioned only once', () => {
  const thread = makeThread({
    threadId: 'engram-core',
    name: 'Engram core',
    description: 'Core memory library.',
  });

  const newBody = [
    '## Context',
    'Quick body text.',
    '',
    '## model-metadata-central plan',
    'Some details about the other project.',
  ].join('\n');

  const warnings = assessThreadCoherence(thread, newBody, []);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].slug, 'model-metadata-central');
});

test('deduplicates warnings when a known thread is referenced multiple times', () => {
  const active = makeThread({ threadId: 'engram-core', name: 'Engram core' });
  const sibling = makeThread({
    threadId: 'engram-plugin',
    name: 'Engram plugin',
    aliases: ['obsidian-plugin'],
  });

  const newBody = [
    '## engram-plugin notes',
    'engram-plugin needs work. See engram-plugin section. Also engram-plugin.',
    'And one mention of obsidian-plugin too.',
  ].join('\n');

  const warnings = assessThreadCoherence(active, newBody, [sibling]);
  // Both engram-plugin and obsidian-plugin map to the same other thread → 1 warning
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].kind, 'known-thread-mention');
});
