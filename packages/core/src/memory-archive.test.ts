import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { MemoryManager } from './memory.js';
import { NodeAdapter } from './adapters/node.js';
import { executeToolCall, extractText } from './tools/registry.js';
import { defaultMemoryConfig, MemoryState, MemoryType } from './types.js';

const DAYS_AGO_OLD = 30;
const MILLISECONDS_PER_DAY = 86_400_000;

async function setup(t: test.TestContext): Promise<{ manager: MemoryManager; engramRoot: string }> {
  const vaultRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'engram-archive-test-'));
  t.after(async () => {
    await fs.rm(vaultRoot, { recursive: true, force: true });
  });

  const engramRoot = path.join(vaultRoot, 'engram');
  const old = new Date(Date.now() - DAYS_AGO_OLD * MILLISECONDS_PER_DAY).toISOString();
  const notes: Array<[string, MemoryState]> = [
    ['memory/facts/a.md', MemoryState.Forgotten],
    ['memory/facts/b.md', MemoryState.Forgotten],
    ['memory/facts/keep.md', MemoryState.Default],
  ];
  // Written raw: VaultNote.save stamps `updated` with now, which would defeat the age filter.
  for (const [relative, state] of notes) {
    const filePath = path.join(engramRoot, relative);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
      filePath,
      `---\ntype: ${MemoryType.Fact}\ncreated: ${old}\nupdated: ${old}\nmemory_state: ${state}\n---\n\n${relative}`,
    );
  }

  return { manager: new MemoryManager(new NodeAdapter(), defaultMemoryConfig(vaultRoot, 'integrated')), engramRoot };
}

async function call(manager: MemoryManager, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  return extractText(await executeToolCall({ manager, name: 'memory', args }));
}

async function exists(filePath: string): Promise<boolean> {
  return await fs.access(filePath).then(() => true, () => false);
}

test('archive rejects inapplicable arguments instead of ignoring them', async (t) => {
  const { manager, engramRoot } = await setup(t);
  const result = await call(manager, { action: 'archive', path: 'memory/facts/a.md', query: 'x' });

  assert.equal(result.isError, true);
  assert.match(result.text, /does not accept 'query'/);
  assert.equal(await exists(path.join(engramRoot, 'memory/facts/a.md')), true);
});

test('archive with no scope refuses instead of sweeping the forgotten tier', async (t) => {
  const { manager, engramRoot } = await setup(t);

  for (const args of [{ action: 'archive' }, { action: 'archive', older_than_days: 0 }]) {
    const result = await call(manager, args);
    assert.equal(result.isError, true);
    assert.match(result.text, /requires a scope/);
  }
  assert.equal(await exists(path.join(engramRoot, 'memory/facts/a.md')), true);
  assert.equal(await exists(path.join(engramRoot, 'memory/facts/b.md')), true);
});

test('archive with path archives exactly that memory', async (t) => {
  const { manager, engramRoot } = await setup(t);
  const result = await call(manager, { action: 'archive', path: 'memory/facts/a' });

  assert.equal(result.isError, false, result.text);
  assert.equal(await exists(path.join(engramRoot, 'memory/facts/a.md')), false);
  assert.equal(await exists(path.join(engramRoot, 'archive/memory/facts/a.md')), true);
  assert.equal(await exists(path.join(engramRoot, 'memory/facts/b.md')), true);
});

test('archive with path and older_than_days together is an error', async (t) => {
  const { manager } = await setup(t);
  const result = await call(manager, { action: 'archive', path: 'memory/facts/a.md', older_than_days: 1 });

  assert.equal(result.isError, true);
  assert.match(result.text, /not both/);
});

test('archive sweep defaults to a dry run and only moves with dry_run: false', async (t) => {
  const { manager, engramRoot } = await setup(t);

  const preview = await call(manager, { action: 'archive', older_than_days: 1 });
  assert.equal(preview.isError, false, preview.text);
  assert.match(preview.text, /Dry run — would archive 2 forgotten note/);
  assert.equal(await exists(path.join(engramRoot, 'memory/facts/a.md')), true);

  const applied = await call(manager, { action: 'archive', older_than_days: 1, dry_run: false });
  assert.match(applied.text, /Archived 2 forgotten note/);
  assert.equal(await exists(path.join(engramRoot, 'memory/facts/a.md')), false);
  assert.equal(await exists(path.join(engramRoot, 'memory/facts/keep.md')), true);
});

test('restore moves an archived memory back and refuses to overwrite', async (t) => {
  const { manager, engramRoot } = await setup(t);
  await call(manager, { action: 'archive', path: 'memory/facts/a.md' });

  const restored = await call(manager, { action: 'restore', path: 'archive/memory/facts/a.md' });
  assert.equal(restored.isError, false, restored.text);
  assert.equal(await exists(path.join(engramRoot, 'memory/facts/a.md')), true);
  assert.equal(await exists(path.join(engramRoot, 'archive/memory/facts/a.md')), false);

  await call(manager, { action: 'archive', path: 'memory/facts/a.md' });
  await fs.copyFile(path.join(engramRoot, 'memory/facts/b.md'), path.join(engramRoot, 'memory/facts/a.md'));
  const clash = await call(manager, { action: 'restore', path: 'archive/memory/facts/a.md' });
  assert.equal(clash.isError, true);
  assert.match(clash.text, /refuses to overwrite/);
});

test('restore only accepts paths inside the archive', async (t) => {
  const { manager } = await setup(t);
  const result = await call(manager, { action: 'restore', path: 'memory/facts/a.md' });

  assert.equal(result.isError, true);
  assert.match(result.text, /inside the archive directory/);
});
