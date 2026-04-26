import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryManager } from './memory.js';
import { NodeAdapter } from './adapters/node.js';
import { VaultNote } from './vault.js';
import { defaultMemoryConfig, MemoryState, MemoryType, ThreadStatus, type NoteFrontmatter } from './types.js';

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
    ['memory:entities/project', 'memory:facts/dreams'],
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
    ['memory:entities/project', 'memory:facts/with-summary'],
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
      'Background motivation that Fragments should rehydrate on bootstrap.',
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
  assert.match(sections[0]?.content ?? '', /Context:\nBackground motivation that Fragments should rehydrate on bootstrap\./);
  assert.match(sections[0]?.content ?? '', /Goals:/);
  assert.match(sections[0]?.content ?? '', /- \[ \] Tighten retrieval prompt/);
  assert.match(sections[0]?.content ?? '', /- \[ \] Add note reference convention/);
  assert.doesNotMatch(sections[0]?.content ?? '', /Finish prior experiment/);
  assert.doesNotMatch(sections[0]?.content ?? '', /Freeform thread notes/);
  assert.equal(sections[1]?.label, 'memory:entities/project');
});

test('thread Context section is token-bounded when it overflows', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));

  // ~1500 tokens of prose — well past the 400-token Context budget.
  const longContext = Array.from({ length: 60 }, (_, index) =>
    `Paragraph ${index + 1}: this thread holds a lot of detailed background that exceeds the Context budget so the loader must truncate it instead of dumping the whole body into the bootstrap context window.`,
  ).join(' ');

  await manager.setThread(
    'overflow-thread',
    ['## Context', longContext].join('\n'),
    { name: 'Overflow Thread' },
  );

  const sections = await manager.getContext('overflow probe', { max: 4000 }, 'overflow-thread');
  const summary = sections[0]?.content ?? '';
  assert.match(summary, /Context:/);
  assert.match(summary, /…$/m);
  assert.ok(
    summary.length < longContext.length,
    'Context body should be truncated when it exceeds the token budget',
  );
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
  const notesDir = path.join(vaultRoot, 'engram', 'inbox', 'threads', 'demo-thread');
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
    'Recent ordinary entry',
    '[COMPACTED] Recent compacted entry',
    '[DREAM SUMMARY] 35 actions applied, 0 skipped.',
    '[DREAMING] I walked through a city of mirrors.',
  ]);
});

test('readScratch bootstrap defaults to the 5 most recent entries', async (t) => {
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
  assert.equal(entries.length, 5);
  assert.deepEqual(
    entries.map((entry) => entry.content),
    Array.from({ length: 5 }, (_, index) => `Entry ${11 - index}`),
  );
});

test('deleteScratch removes entries by session id', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const scratchPath = path.join(vaultRoot, 'engram', '.scratch');

  await fs.mkdir(path.dirname(scratchPath), { recursive: true });
  await fs.writeFile(
    scratchPath,
    [
      `[dreams | ${new Date(Date.now() - 10_000).toISOString()}] [DREAM START] Falling asleep...`,
      `[dreams | ${new Date(Date.now() - 9_000).toISOString()}] [DREAM END] 3 actions applied.`,
      `[session-a | ${new Date(Date.now() - 8_000).toISOString()}] Keep me`,
    ].join('\n'),
  );

  const removed = await manager.deleteScratch({ sessionId: 'dreams', thresholdMs: 0 });
  assert.equal(removed, 2);

  const remaining = await manager.readScratch();
  assert.deepEqual(remaining.map((entry) => entry.sessionId), ['session-a']);
  assert.deepEqual(remaining.map((entry) => entry.content), ['Keep me']);
});

test('deleteScratch filters by match text and threshold age', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const scratchPath = path.join(vaultRoot, 'engram', '.scratch');

  await fs.mkdir(path.dirname(scratchPath), { recursive: true });
  await fs.writeFile(
    scratchPath,
    [
      `[dreams | ${new Date(Date.now() - 7_200_000).toISOString()}] [DREAM END] old summary`,
      `[dreams | ${new Date(Date.now() - 60_000).toISOString()}] [DREAM END] recent summary`,
      `[session-a | ${new Date(Date.now() - 7_200_000).toISOString()}] unrelated entry`,
    ].join('\n'),
  );

  const removed = await manager.deleteScratch({
    sessionId: 'dreams',
    matchText: '[DREAM END]',
    thresholdMs: 3_600_000,
  });
  assert.equal(removed, 1);

  const remaining = await manager.readScratch();
  assert.deepEqual(remaining.map((entry) => entry.content), [
    'unrelated entry',
    '[DREAM END] recent summary',
  ]);
});

test('sweepScratch removes entries older than bootstrap retention window', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const scratchPath = path.join(vaultRoot, 'engram', '.scratch');

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(scratchPath), { recursive: true });
  await fs.writeFile(
    scratchPath,
    [
      `[session-a | ${eightDaysAgo}] very old entry`,
      `[session-b | ${oneDayAgo}] recent entry`,
      `[session-c | ${twoDaysAgo}] [COMPACTED] recent compacted — should stay (within 72h)`,
    ].join('\n'),
  );

  const removed = await manager.sweepScratch();
  assert.equal(removed, 1);

  const remaining = await manager.readScratch();
  assert.deepEqual(remaining.map((e) => e.content), [
    '[COMPACTED] recent compacted — should stay (within 72h)',
    'recent entry',
  ]);
});

test('sweepScratch removes compacted entries older than 72 hours', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const scratchPath = path.join(vaultRoot, 'engram', '.scratch');

  const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(scratchPath), { recursive: true });
  await fs.writeFile(
    scratchPath,
    [
      `[session-a | ${fourDaysAgo}] [COMPACTED] stale compacted`,
      `[session-b | ${oneHourAgo}] [COMPACTED] fresh compacted — keep`,
      `[session-c | ${oneDayAgo}] uncompacted recent — keep`,
    ].join('\n'),
  );

  const removed = await manager.sweepScratch();
  assert.equal(removed, 1);

  const remaining = await manager.readScratch();
  assert.deepEqual(remaining.map((e) => e.content), [
    'uncompacted recent — keep',
    '[COMPACTED] fresh compacted — keep',
  ]);
});

test('appendScratch auto-sweeps bootstrap-invisible entries from the file', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const scratchPath = path.join(vaultRoot, 'engram', '.scratch');

  const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  await fs.mkdir(path.dirname(scratchPath), { recursive: true });
  await fs.writeFile(
    scratchPath,
    [
      `[session-a | ${eightDaysAgo}] stale entry that should be swept`,
      `[session-b | ${oneDayAgo}] recent entry`,
    ].join('\n'),
  );

  await manager.appendScratch('session-c', 'new entry');

  const remaining = await manager.readScratch();
  assert.equal(remaining.length, 2);
  assert.deepEqual(remaining.map((e) => e.content), ['recent entry', 'new entry']);
});

test('resolveThread stamps detected git remote on auto-created threads', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'my-project');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => 'git@github.com:example/project.git' },
  );

  const resolved = await manager.resolveThread({ cwd });
  assert.equal(resolved.created, true);
  assert.deepEqual(resolved.thread.frontmatter.repositories, ['github.com/example/project']);
});

test('resolveThread surfaces candidates when a moved repo still matches by remote', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const oldPath = path.join(vaultRoot, 'old-location');
  const newPath = path.join(vaultRoot, 'new-location');
  await fs.mkdir(oldPath, { recursive: true });
  await fs.mkdir(newPath, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => 'git@github.com:example/project.git' },
  );

  await manager.setThread('historical', '', {
    paths: [oldPath],
    repositories: ['github.com/example/project'],
  });

  const resolved = await manager.resolveThread({ cwd: newPath, autoCreate: false });
  assert.equal(resolved.threadId, 'historical');
  assert.equal(resolved.created, false);
});

test('resolveThread follows superseded_by forwarding', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'project');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => undefined, detectPackageNames: () => [] },
  );

  await manager.setThread('new-home', '', { paths: [cwd] });
  await manager.setThread('old-home', '', {
    paths: [cwd],
    superseded_by: 'new-home',
  });

  const resolved = await manager.resolveThread({ cwd, autoCreate: false });
  assert.equal(resolved.threadId, 'new-home');
  const suppressed = (resolved.candidates ?? []).map((c) => c.threadId);
  assert.equal(suppressed.includes('old-home'), false);
});

test('getThread resolves by alias', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
  );

  await manager.setThread('canonical', '', { aliases: ['legacy-slug', 'another-slug'] });

  const byAlias = await manager.getThread('legacy-slug');
  assert.notEqual(byAlias, null);
  assert.equal(byAlias?.frontmatter.thread_id, 'canonical');
});

test('mergeThreads stamps superseded_by on the source', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
  );

  await manager.setThread('source-thread', '', {});
  await manager.setThread('target-thread', '', {});

  await manager.mergeThreads('source-thread', 'target-thread');

  const source = await manager.getThread('source-thread');
  assert.equal(source?.frontmatter.superseded_by, 'target-thread');
  const target = await manager.getThread('target-thread');
  const aliases = target?.frontmatter.aliases as string[] | undefined;
  assert.ok(aliases !== undefined && aliases.includes('source-thread'));
});

test('resolveThread surfaces declared related_threads as candidates with reason "related"', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'project');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => undefined, detectPackageNames: () => [] },
  );

  await manager.setThread('sibling-a', '', { name: 'Sibling A' });
  await manager.setThread('sibling-b', '', { name: 'Sibling B' });
  await manager.setThread('primary', '', {
    paths: [cwd],
    related_threads: ['sibling-a', 'sibling-b'],
  });

  const resolved = await manager.resolveThread({ cwd });
  assert.equal(resolved.threadId, 'primary');
  const related = (resolved.candidates ?? []).filter((c) => c.reason === 'related');
  assert.deepEqual(related.map((c) => c.threadId).sort(), ['sibling-a', 'sibling-b']);
  assert.equal(related.find((c) => c.threadId === 'sibling-a')?.name, 'Sibling A');
});

test('resolveThread related_threads candidates resolve via aliases and skip missing refs', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'project');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => undefined, detectPackageNames: () => [] },
  );

  await manager.setThread('canonical-sibling', '', {
    name: 'Canonical Sibling',
    aliases: ['legacy-sibling'],
  });
  await manager.setThread('primary', '', {
    paths: [cwd],
    related_threads: ['legacy-sibling', 'does-not-exist'],
  });

  const resolved = await manager.resolveThread({ cwd });
  const related = (resolved.candidates ?? []).filter((c) => c.reason === 'related');
  assert.deepEqual(related.map((c) => c.threadId), ['canonical-sibling']);
});

test('resolveThread does not duplicate related_threads when same thread already matched', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'project');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => 'git@github.com:example/project.git', detectPackageNames: () => [] },
  );

  // Two threads share the remote, primary will win, alt will appear as a remote-match candidate.
  await manager.setThread('alt', '', {
    name: 'Alt',
    repositories: ['github.com/example/project'],
  });
  await manager.setThread('primary', '', {
    paths: [cwd],
    repositories: ['github.com/example/project'],
    related_threads: ['alt'],
  });

  const resolved = await manager.resolveThread({ cwd });
  assert.equal(resolved.threadId, 'primary');
  const altCandidates = (resolved.candidates ?? []).filter((c) => c.threadId === 'alt');
  assert.equal(altCandidates.length, 1, 'alt should appear once, not duplicated under "related"');
  assert.notEqual(altCandidates[0].reason, 'related');
});

test('getContext surfaces a related-threads section when other threads have query hits', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  await manager.setThread('active-thread', '## Todo\n- [ ] Stay focused', { name: 'Active Thread' });
  await manager.setThread('other-thread', '## Todo\n- [ ] Side quest', { name: 'Other Thread' });

  await writeNote(
    vaultRoot,
    'memory/facts/active-fact.md',
    {
      memory_state: MemoryState.Default,
      thread: 'active-thread',
      summary: 'Active-thread fact about retrieval pipeline',
    },
    'Active-thread fact about retrieval pipeline',
  );

  await writeNote(
    vaultRoot,
    'memory/facts/cross-thread-fact.md',
    {
      memory_state: MemoryState.Default,
      thread: 'other-thread',
      summary: 'Other-thread retrieval pipeline tuning notes',
    },
    'Other-thread retrieval pipeline tuning notes',
  );

  const sections = await manager.getContext('retrieval pipeline', { max: 2000 }, 'active-thread');
  const related = sections.find((s) => s.label === 'related-threads:active-thread');
  assert.ok(related, 'related-threads section should be present');
  assert.match(related.content, /Possibly related threads/);
  assert.match(related.content, /other-thread \(Other Thread\)/);
  assert.match(related.content, /Other-thread retrieval pipeline tuning notes/);
  assert.doesNotMatch(related.content, /active-thread \(Active Thread\)/);

  const labels = sections.map((s) => s.label);
  assert.ok(!labels.includes('memory:facts/cross-thread-fact'), 'cross-thread note should not appear as a regular section');
});

test('getContext omits related-threads section when no other threads match the query', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  await manager.setThread('active-thread', '## Todo\n- [ ] Stay focused', { name: 'Active Thread' });
  await manager.setThread('other-thread', '## Todo\n- [ ] Side quest', { name: 'Other Thread' });

  await writeNote(
    vaultRoot,
    'memory/facts/cross-thread-fact.md',
    {
      memory_state: MemoryState.Default,
      thread: 'other-thread',
      summary: 'Completely unrelated topic about gardening',
    },
    'Completely unrelated topic about gardening',
  );

  const sections = await manager.getContext('retrieval pipeline', { max: 2000 }, 'active-thread');
  assert.equal(sections.find((s) => s.label === 'related-threads:active-thread'), undefined);
});

test('getContext related-threads section caps at top-scoring threads ordered by score', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  await manager.setThread('active', '', { name: 'Active' });

  // Five other threads with hits; only top 3 should surface.
  for (let i = 0; i < 5; i += 1) {
    const threadId = `cross-${i}`;
    await manager.setThread(threadId, '', { name: `Cross ${i}` });
    // Vary summary strength: i=0 has only one weak token, i=4 matches all tokens strongly.
    const summaryWords = i >= 3
      ? 'retrieval pipeline tuning'
      : i === 2
        ? 'retrieval pipeline'
        : 'retrieval';
    await writeNote(
      vaultRoot,
      `memory/facts/cross-${i}-fact.md`,
      {
        memory_state: MemoryState.Default,
        thread: threadId,
        summary: `Cross ${i} note about ${summaryWords}`,
      },
      `Cross ${i} note about ${summaryWords}`,
    );
  }

  const sections = await manager.getContext('retrieval pipeline tuning', { max: 4000 }, 'active');
  const related = sections.find((s) => s.label === 'related-threads:active');
  assert.ok(related, 'related-threads section should be present');

  const surfaced = ['cross-0', 'cross-1', 'cross-2', 'cross-3', 'cross-4']
    .filter((id) => related.content.includes(id));
  assert.equal(surfaced.length, 3, 'should cap at 3 related threads');
  // The two strongest matches (cross-3, cross-4 — full token coverage) must be present.
  assert.ok(surfaced.includes('cross-3'));
  assert.ok(surfaced.includes('cross-4'));
});

test('getContext related-threads section surfaces threads matched by their own name/description', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  await manager.setThread('active-thread', '## Todo\n- [ ] Stay focused', { name: 'Active Thread' });
  await manager.setThread('docs-only-thread', '', {
    name: 'Retrieval Pipeline Tuning',
    description: 'Iterating on the retrieval pipeline scoring weights and thresholds.',
    goals: ['Improve recall', 'Trim noise from scoring'],
  });

  const sections = await manager.getContext('retrieval pipeline tuning', { max: 2000 }, 'active-thread');
  const related = sections.find((s) => s.label === 'related-threads:active-thread');
  assert.ok(related, 'related-threads section should be present');
  assert.match(related.content, /docs-only-thread \(Retrieval Pipeline Tuning\)/);
  assert.match(related.content, /thread text match/);
  assert.doesNotMatch(related.content, /memory match/);
});

test('getContext related-threads section combines memory hits and thread-text matches for the same thread', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  await manager.setThread('active-thread', '', { name: 'Active Thread' });
  await manager.setThread('combo-thread', '', {
    name: 'Retrieval Pipeline',
    description: 'Tuning the retrieval pipeline.',
  });

  await writeNote(
    vaultRoot,
    'memory/facts/combo-fact.md',
    {
      memory_state: MemoryState.Default,
      thread: 'combo-thread',
      summary: 'Notes on retrieval pipeline scoring',
    },
    'Notes on retrieval pipeline scoring',
  );

  const sections = await manager.getContext('retrieval pipeline', { max: 2000 }, 'active-thread');
  const related = sections.find((s) => s.label === 'related-threads:active-thread');
  assert.ok(related, 'related-threads section should be present');
  assert.match(related.content, /combo-thread \(Retrieval Pipeline\) — 1 memory match \+ thread text match; top:/);
});

test('getContext skips related-threads section when no thread is active', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  await manager.setThread('other-thread', '', { name: 'Other Thread' });

  await writeNote(
    vaultRoot,
    'memory/facts/cross-thread-fact.md',
    {
      memory_state: MemoryState.Default,
      thread: 'other-thread',
      summary: 'Other-thread retrieval pipeline tuning notes',
    },
    'Other-thread retrieval pipeline tuning notes',
  );

  const sections = await manager.getContext('retrieval pipeline', { max: 2000 });
  assert.equal(sections.find((s) => s.label.startsWith('related-threads:')), undefined);
});

test('resolveThread auto-create stamps detected package names', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'workspace', 'pkg-foo');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    {
      detectGitRemote: () => undefined,
      detectPackageNames: () => ['@org/foo', '@org/workspace'],
    },
  );

  const resolved = await manager.resolveThread({ cwd });
  assert.equal(resolved.created, true);
  assert.deepEqual(resolved.thread.frontmatter.packages, ['@org/foo', '@org/workspace']);
});

test('setThread with status=planned stamps planned_at', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const manager = new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated'));
  const thread = await manager.setThread('future-revival', '## Context\nReviving the old project.', {
    name: 'Future Revival',
    status: ThreadStatus.Planned,
    repositories: ['github.com/me/old-project'],
  });

  assert.equal(thread.frontmatter.status, ThreadStatus.Planned);
  assert.equal(typeof thread.frontmatter.planned_at, 'string');
  assert.equal(thread.frontmatter.activated_at, undefined);
});

test('resolveThread auto-activates a planned thread when git remote matches', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'fresh-clone');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => 'git@github.com:me/old-project.git', detectPackageNames: () => [] },
  );

  await manager.setThread('future-revival', '## Context\nReviving the old project.', {
    name: 'Future Revival',
    status: ThreadStatus.Planned,
    repositories: ['github.com/me/old-project'],
  });

  const resolved = await manager.resolveThread({ cwd });
  assert.equal(resolved.threadId, 'future-revival');
  assert.equal(resolved.created, false);
  assert.equal(resolved.activated, true);
  assert.equal(resolved.thread.frontmatter.status, ThreadStatus.Active);
  assert.equal(typeof resolved.thread.frontmatter.activated_at, 'string');
  assert.equal(typeof resolved.thread.frontmatter.planned_at, 'string');
  assert.equal(typeof resolved.thread.frontmatter.last_active, 'string');
});

test('resolveThread auto-activates a planned thread when cwd path matches', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'planned-spot');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => undefined, detectPackageNames: () => [] },
  );

  await manager.setThread('planned-via-path', '', {
    name: 'Planned via Path',
    status: ThreadStatus.Planned,
    paths: [cwd],
  });

  const resolved = await manager.resolveThread({ cwd });
  assert.equal(resolved.threadId, 'planned-via-path');
  assert.equal(resolved.activated, true);
  assert.equal(resolved.thread.frontmatter.status, ThreadStatus.Active);
});

test('resolveThread does not select a planned thread when no env signal matches', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'unrelated-dir');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => undefined, detectPackageNames: () => [] },
  );

  await manager.setThread('untouched-plan', '', {
    name: 'Untouched Plan',
    status: ThreadStatus.Planned,
    repositories: ['github.com/me/some-other-repo'],
    paths: [path.join(vaultRoot, 'somewhere-else')],
  });

  const resolved = await manager.resolveThread({ cwd });
  // Falls through to auto-create a new thread for cwd; the planned thread must not be picked.
  assert.notEqual(resolved.threadId, 'untouched-plan');
  assert.equal(resolved.activated, false);

  const planned = await manager.getThread('untouched-plan');
  assert.equal(planned?.frontmatter.status, ThreadStatus.Planned);
  assert.equal(planned?.frontmatter.activated_at, undefined);
});

test('resolveThread prefers active match over planned match when both have signals', async (t) => {
  const vaultRoot = await createTempVault();
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const cwd = path.join(vaultRoot, 'shared-cwd');
  await fs.mkdir(cwd, { recursive: true });

  const manager = new MemoryManager(
    new NodeAdapter(),
    defaultMemoryConfig(vaultRoot, 'integrated'),
    { detectGitRemote: () => undefined, detectPackageNames: () => [] },
  );

  await manager.setThread('current-active', '', {
    name: 'Current Active',
    status: ThreadStatus.Active,
    paths: [cwd],
  });
  await manager.setThread('also-planned', '', {
    name: 'Also Planned',
    status: ThreadStatus.Planned,
    paths: [cwd],
  });

  const resolved = await manager.resolveThread({ cwd });
  assert.equal(resolved.threadId, 'current-active');
  assert.equal(resolved.activated, false);

  const stillPlanned = await manager.getThread('also-planned');
  assert.equal(stillPlanned?.frontmatter.status, ThreadStatus.Planned);
});

