import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryManager } from './memory';
import { NodeAdapter } from './adapters/node';
import { VaultNote } from './vault';
import { defaultMemoryConfig, MemoryState, MemoryType, type NoteFrontmatter } from './types';

async function createTempVault(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'engram-memory-test-'));
}

async function writeNote(
  vaultRoot: string,
  relativePath: string,
  frontmatter: Partial<NoteFrontmatter>,
  content: string,
): Promise<void> {
  const adapter = new NodeAdapter();
  const filePath = path.join(vaultRoot, 'engram', relativePath);
  const now = new Date().toISOString();

  await VaultNote.create(
    adapter,
    filePath,
    {
      type: MemoryType.Fact,
      created: now,
      updated: now,
      memory_state: MemoryState.Default,
      ...frontmatter,
    } as NoteFrontmatter,
    content,
  );
}

test('getContext uses memory-root-relative labels', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  await writeNote(
    vaultRoot,
    'memory/entities/project.md',
    {
      type: MemoryType.Entity,
      memory_state: MemoryState.Core,
      summary: 'Core project memory summary',
    },
    'Core project memory summary',
  );

  await writeNote(
    vaultRoot,
    'memory/facts/dreams.md',
    {
      type: MemoryType.Fact,
      memory_state: MemoryState.Default,
      summary: 'Dreams consolidation validated',
    },
    'Longer body that should not matter for the label test.',
  );

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const sections = await manager.getContext('dreams consolidation', { max: 1000 });

  assert.deepEqual(
    sections.map((section) => section.label),
    ['memory:entities/project.md', 'memory:facts/dreams.md'],
  );
});

test('getContext skips non-core notes without summaries', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  await writeNote(
    vaultRoot,
    'memory/entities/project.md',
    {
      type: MemoryType.Entity,
      memory_state: MemoryState.Core,
      summary: 'Core project memory summary',
    },
    'Core project memory summary',
  );

  await writeNote(
    vaultRoot,
    'memory/facts/with-summary.md',
    {
      type: MemoryType.Fact,
      memory_state: MemoryState.Default,
      summary: 'Dreams consolidation summary',
    },
    'Long detailed body about dreams consolidation that should stay out of prompt context.',
  );

  await writeNote(
    vaultRoot,
    'memory/facts/no-summary.md',
    {
      type: MemoryType.Fact,
      memory_state: MemoryState.Default,
    },
    'Dreams consolidation full body with lots of detail that used to leak into context when no summary existed.',
  );

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const sections = await manager.getContext('dreams consolidation', { max: 1000 });

  assert.deepEqual(
    sections.map((section) => section.label),
    ['memory:entities/project.md', 'memory:facts/with-summary.md'],
  );
  assert.equal(sections[1]?.content, 'Dreams consolidation summary');
});

test('getContext includes a compact active thread summary with open todos', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await writeNote(
    vaultRoot,
    'memory/entities/project.md',
    {
      type: MemoryType.Entity,
      memory_state: MemoryState.Core,
      summary: 'Core project memory summary',
    },
    'Core project memory summary',
  );

  await manager.setThread(
    'demo-thread',
    [
      '## Context',
      'Some background that should not matter much.',
      '',
      '## Todo',
      '- [ ] Tighten retrieval prompt',
      '- [x] Finish prior experiment',
      '* [ ] Add note reference convention',
      '',
      '## Notes',
      'Freeform thread notes.',
    ].join('\n'),
    {
      name: 'Demo Thread',
      description: 'Testing thread summary inclusion for bootstrap context.',
      goals: ['Ship lean context retrieval', 'Keep thread planning lightweight'],
    },
  );

  const sections = await manager.getContext('thread bootstrap', { max: 1000 }, 'demo-thread');
  assert.equal(sections[0]?.label, 'thread:demo-thread');
  assert.match(sections[0]?.content ?? '', /Thread: Demo Thread/);
  assert.match(sections[0]?.content ?? '', /Status: active/);
  assert.match(sections[0]?.content ?? '', /Goals:/);
  assert.match(sections[0]?.content ?? '', /- \[ \] Tighten retrieval prompt/);
  assert.match(sections[0]?.content ?? '', /- \[ \] Add note reference convention/);
  assert.doesNotMatch(sections[0]?.content ?? '', /Finish prior experiment/);
  assert.equal(sections[1]?.label, 'memory:entities/project.md');
});

test('getContext includes thread inbox notes ahead of core memories', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await writeNote(
    vaultRoot,
    'memory/entities/project.md',
    {
      type: MemoryType.Entity,
      memory_state: MemoryState.Core,
    },
    'Core project memory summary',
  );

  await manager.setThread(
    'demo-thread',
    '## Todo\n- [ ] Keep durable work visible',
    { name: 'Demo Thread' },
  );

  await manager.addThreadInboxItem('demo-thread', 'Pick up the handoff note');
  await manager.addThreadInboxItem('demo-thread', 'Double-check the next bootstrap step');
  await manager.removeThreadInboxItem('demo-thread', 'Double-check the next bootstrap step');

  const sections = await manager.getContext('resume the workstream', { max: 1000 }, 'demo-thread');
  assert.equal(sections[0]?.label, 'thread:demo-thread');
  assert.equal(sections[1]?.label, 'thread-inbox:demo-thread');
  assert.match(sections[1]?.content ?? '', /Thread Inbox/);
  assert.match(sections[1]?.content ?? '', /Pick up the handoff note/);
  assert.doesNotMatch(sections[1]?.content ?? '', /Double-check the next bootstrap step/);
});

test('getContext includes arbitrary global inbox notes and keeps thread inbox separate', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await writeNote(
    vaultRoot,
    'memory/entities/project.md',
    {
      type: MemoryType.Entity,
      memory_state: MemoryState.Core,
    },
    'Core project memory summary',
  );

  await manager.setThread(
    'demo-thread',
    '## Todo\n- [ ] Keep durable work visible',
    { name: 'Demo Thread' },
  );

  await manager.createNote(
    'inbox/mobile-capture',
    '# While Out\n\nFollow up on the global inbox design from mobile.',
  );
  await manager.addThreadInboxItem('demo-thread', 'Thread-specific handoff item');

  const sections = await manager.getContext('resume the workstream', { max: 1000 }, 'demo-thread');
  assert.equal(sections[0]?.label, 'thread:demo-thread');
  assert.equal(sections[1]?.label, 'inbox:global');
  assert.equal(sections[2]?.label, 'thread-inbox:demo-thread');
  assert.match(sections[1]?.content ?? '', /Global Inbox:/);
  assert.match(sections[1]?.content ?? '', /While Out \(inbox\/mobile-capture\.md\): Follow up on the global inbox design from mobile\./);
  assert.doesNotMatch(sections[1]?.content ?? '', /Thread-specific handoff item/);
  assert.match(sections[2]?.content ?? '', /Thread Inbox/);
  assert.match(sections[2]?.content ?? '', /Thread-specific handoff item/);
});

test('global inbox picks up notes inside inbox/ directory but not a note at inbox itself', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await manager.setThread(
    'demo-thread',
    '## Todo\n- [ ] Check inbox behavior',
    { name: 'Demo Thread' },
  );

  // Create a note INSIDE the inbox directory — this should be picked up
  await manager.createNote(
    'inbox/check-api-limits',
    '# API Limits\n\nVerify rate limits before launch.',
  );

  // Create a note AT inbox — this produces inbox.md next to the directory and should NOT be picked up
  await manager.createNote(
    'inbox',
    '# Misplaced Note\n\nThis should not surface in the inbox.',
  );

  const sections = await manager.getContext('session start', { max: 1000 }, 'demo-thread');
  const globalInbox = sections.find((s) => s.label === 'inbox:global');

  assert.ok(globalInbox, 'global inbox section should be present');
  assert.match(globalInbox.content, /API Limits/);
  assert.doesNotMatch(globalInbox.content, /Misplaced Note/);
});

test('thread inbox reads legacy single-file inbox notes for backward compatibility', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await manager.setThread('demo-thread', '## Todo\n- [ ] Existing task', { name: 'Demo Thread' });
  await manager.createNote(
    'inbox/demo-thread',
    '## Inbox\n- [ ] Legacy handoff item',
  );

  const items = await manager.listThreadInbox('demo-thread');
  assert.equal(items.length, 1);
  assert.match(items[0].content, /Legacy handoff item/);
  assert.match(items[0].path, /inbox\/demo-thread/);
});

test('thread inbox items sort by created date (FIFO)', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  await manager.setThread('demo-thread', 'Thread body', { name: 'Demo Thread' });

  // Create notes with explicit created dates out of order
  const notesDir = path.join(vaultRoot, 'engram', 'notes', 'inbox', 'threads', 'demo-thread');
  await fs.mkdir(notesDir, { recursive: true });
  await fs.writeFile(
    path.join(notesDir, 'second-item.md'),
    '---\ncreated: 2026-04-02T00:00:00.000Z\n---\n\nSecond item',
  );
  await fs.writeFile(
    path.join(notesDir, 'first-item.md'),
    '---\ncreated: 2026-04-01T00:00:00.000Z\n---\n\nFirst item',
  );
  await fs.writeFile(
    path.join(notesDir, 'third-item.md'),
    '---\ncreated: 2026-04-03T00:00:00.000Z\n---\n\nThird item',
  );

  const items = await manager.listThreadInbox('demo-thread');
  assert.equal(items.length, 3);
  assert.match(items[0].content, /First item/);
  assert.match(items[1].content, /Second item/);
  assert.match(items[2].content, /Third item/);
});

test('thread inbox add and remove lifecycle', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  await manager.setThread('demo-thread', 'Thread body', { name: 'Demo Thread' });

  await manager.addThreadInboxItem('demo-thread', 'First handoff');
  await manager.addThreadInboxItem('demo-thread', 'Second handoff');

  let items = await manager.listThreadInbox('demo-thread');
  assert.equal(items.length, 2);

  // Remove by original text (slug match)
  await manager.removeThreadInboxItem('demo-thread', 'First handoff');
  items = await manager.listThreadInbox('demo-thread');
  assert.equal(items.length, 1);
  assert.match(items[0].content, /Second handoff/);

  // Complete (alias for remove) by original text
  await manager.completeThreadInboxItem('demo-thread', 'Second handoff');
  items = await manager.listThreadInbox('demo-thread');
  assert.equal(items.length, 0);
});

test('thread todo helpers add, complete, reopen, and remove checklist items', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await manager.setThread(
    'demo-thread',
    '## Todo\n- [ ] Existing durable task',
    { name: 'Demo Thread' },
  );

  await manager.addThreadTodo('demo-thread', 'Fresh task for the next fragment');
  await manager.completeThreadTodo('demo-thread', 'Existing durable task');

  assert.deepEqual(
    await manager.listThreadTodos('demo-thread', { includeCompleted: true }),
    [
      { text: 'Existing durable task', checked: true },
      { text: 'Fresh task for the next fragment', checked: false },
    ],
  );

  await manager.reopenThreadTodo('demo-thread', 'Existing durable task');
  await manager.removeThreadTodo('demo-thread', 'Fresh task for the next fragment');

  assert.deepEqual(
    await manager.listThreadTodos('demo-thread', { includeCompleted: true }),
    [{ text: 'Existing durable task', checked: false }],
  );
});

test('note CRUD stays inside engram/notes and round-trips content', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  const createdPath = await manager.createNote(
    'blog/session-21-after-the-dream.md',
    '# Session 21\n\nInitial draft.',
  );

  assert.equal(
    createdPath,
    path.join(vaultRoot, 'engram', 'notes', 'blog', 'session-21-after-the-dream.md'),
  );
  assert.equal(await manager.readNote('blog/session-21-after-the-dream'), '# Session 21\n\nInitial draft.');

  const updatedPath = await manager.updateNote(
    'blog/session-21-after-the-dream',
    '# Session 21\n\nRevised draft.',
  );
  assert.equal(updatedPath, createdPath);
  assert.equal(await manager.readNote('blog/session-21-after-the-dream.md'), '# Session 21\n\nRevised draft.');

  const deletedPath = await manager.deleteNote('blog/session-21-after-the-dream');
  assert.equal(deletedPath, createdPath);
  await assert.rejects(async () => await manager.readNote('blog/session-21-after-the-dream'));
});

test('note CRUD rejects paths outside engram/notes', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await assert.rejects(
    async () => await manager.createNote('../memory/facts/not-allowed', 'nope'),
    /notes directory/,
  );
  await assert.rejects(
    async () => await manager.readNote(path.join(vaultRoot, 'engram', 'memory', 'facts', 'not-allowed.md')),
    /notes directory/,
  );
});

test('updateNote detects conflicts when expected content is stale', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await manager.createNote('blog/conflict-note', '# Title\n\nOriginal');
  await manager.updateNote('blog/conflict-note', '# Title\n\nRemote edit');

  await assert.rejects(
    async () => await manager.updateNote(
      'blog/conflict-note',
      '# Title\n\nMy local edit',
      '# Title\n\nOriginal',
    ),
    /changed since last read/,
  );

  assert.equal(await manager.readNote('blog/conflict-note'), '# Title\n\nRemote edit');
});

test('updateNote normalizes line endings and avoids unnecessary rewrites', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await manager.createNote('blog/line-endings', '# Title\r\n\r\nBody');
  assert.equal(await manager.readNote('blog/line-endings'), '# Title\n\nBody');

  await manager.updateNote('blog/line-endings', '# Title\r\n\r\nBody', '# Title\n\nBody');
  assert.equal(await manager.readNote('blog/line-endings'), '# Title\n\nBody');
});

test('appendNote creates missing notes and appends with separator', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await manager.appendNote('blog/session-22', '# Session 22');
  assert.equal(await manager.readNote('blog/session-22'), '# Session 22');

  await manager.appendNote('blog/session-22', 'Second paragraph', { separator: '\n\n' });
  assert.equal(await manager.readNote('blog/session-22'), '# Session 22\n\nSecond paragraph');
});

test('appendNote detects conflicts when expected content is stale', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await manager.createNote('blog/append-conflict', 'Original');
  await manager.appendNote('blog/append-conflict', 'Remote addition');

  await assert.rejects(
    async () => await manager.appendNote(
      'blog/append-conflict',
      'My local addition',
      { expectedCurrentContent: 'Original' },
    ),
    /changed since last read/,
  );

  assert.equal(await manager.readNote('blog/append-conflict'), 'Original\n\nRemote addition');
});

test('listNotes returns relative note paths with previews', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await manager.createNote('blog/a-note', '# A\n\nAlpha preview');
  await manager.createNote('blog/b-note', '# B\n\nBeta preview');
  await manager.createNote('drafts/c-note', '# C\n\nGamma preview');

  const all = await manager.listNotes({ limit: 10 });
  assert.deepEqual(all.map((note) => note.path), [
    'blog/a-note.md',
    'blog/b-note.md',
    'drafts/c-note.md',
  ]);
  assert.equal(all[0]?.preview, '# A\n\nAlpha preview');

  const blogOnly = await manager.listNotes({ prefix: 'blog' });
  assert.deepEqual(blogOnly.map((note) => note.path), [
    'blog/a-note.md',
    'blog/b-note.md',
  ]);
});

test('searchNotes searches only note content and returns relative paths', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  await manager.createNote('blog/dream-report', '# Dream Report\n\nDreams consolidation succeeded.');
  await manager.createNote('blog/other-note', '# Other\n\nCompletely unrelated text.');

  const results = await manager.searchNotes('dreams consolidation', { limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.path, 'blog/dream-report.md');
  assert.match(results[0]?.preview ?? '', /Dreams consolidation succeeded/);
  assert.ok((results[0]?.score ?? 0) > 0);
});

test('readScratch bootstrap compacts dream sequences and drops stale entries', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const scratchPath = path.join(vaultRoot, 'engram', '.scratch');
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(scratchPath), { recursive: true });
  await fs.writeFile(
    scratchPath,
    [
      `[stale | ${hoursAgo(24 * 8)}] Too old for bootstrap`,
      `[old-compact | ${hoursAgo(96)}] [COMPACTED] Old compacted entry`,
      `[dreams | ${hoursAgo(50)}] [DREAM START] Falling asleep...`,
      `[dreams | ${hoursAgo(49)}] [DREAMING] I walked through a city of mirrors.`,
      `[dreams | ${hoursAgo(48)}] [DREAM END] 35 actions applied, 0 skipped. | Vault: 54 memories.`,
      `[recent-compact | ${hoursAgo(47)}] [COMPACTED] Recent compacted entry`,
      `[recent | ${hoursAgo(24)}] Recent ordinary entry`,
    ].join('\n'),
  );

  const entries = await manager.readScratch({ bootstrap: true });

  assert.deepEqual(entries.map((entry) => entry.content), [
    '[DREAMING] I walked through a city of mirrors.',
    '[DREAM SUMMARY] 35 actions applied, 0 skipped.',
    '[COMPACTED] Recent compacted entry',
    'Recent ordinary entry',
  ]);
});

test('readScratch bootstrap defaults to the 10 most recent entries', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const scratchPath = path.join(vaultRoot, 'engram', '.scratch');

  await fs.mkdir(path.dirname(scratchPath), { recursive: true });
  await fs.writeFile(
    scratchPath,
    Array.from({ length: 12 }, (_, index) => {
      const timestamp = new Date(Date.now() - (12 - index) * 60 * 1000).toISOString();
      return `[session-${index} | ${timestamp}] Entry ${index}`;
    }).join('\n'),
  );

  const entries = await manager.readScratch({ bootstrap: true });
  assert.equal(entries.length, 10);
  assert.deepEqual(
    entries.map((entry) => entry.content),
    Array.from({ length: 10 }, (_, index) => `Entry ${index + 2}`),
  );
});
