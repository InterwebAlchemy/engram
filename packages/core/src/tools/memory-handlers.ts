import type { MemoryManager } from '../memory';
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SCRATCH_THRESHOLD_HOURS,
  DEFAULT_SEARCH_LIMIT,
  LONG_PREVIEW_LENGTH,
  MARKDOWN_SUFFIX_PATTERN,
  MEMORY_STATE_MAP,
  MEMORY_TYPE_MAP,
  MILLISECONDS_PER_HOUR,
  SESSION_ID,
  SHORT_PREVIEW_LENGTH,
  buildCheckpointReminder,
} from './definitions';
import {
  type ToolArgs,
  type ToolResponse,
  hasOwnArg,
  jsonText,
  optionalBooleanArg,
  optionalBootstrapStateArg,
  optionalConfidenceArg,
  optionalMappedArg,
  optionalMessagesArg,
  optionalNumberArg,
  optionalStringArg,
  optionalStringArrayArg,
  requireEnumArg,
  requireStringArg,
  requiredMappedArg,
  textResult,
} from './args';
import { renderBootstrapScratch } from '../scratch-helpers';
import { estimateTokens } from '../tokenizer';

const MEMORY_ACTIONS = ['store', 'read', 'update', 'search', 'list', 'archive'] as const;
const SOUL_ACTIONS = ['get', 'set'] as const;
const NOTE_ACTIONS = ['create', 'read', 'update', 'append', 'list', 'search', 'delete'] as const;
const CONVERSATION_ACTIONS = ['save'] as const;
const SKILL_ACTIONS = ['store', 'get', 'list'] as const;
const SCRATCH_ACTIONS = ['append', 'read', 'compact', 'prune', 'delete', 'clear'] as const;

export async function handleMemoryTool(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  switch (requireEnumArg(args, 'action', MEMORY_ACTIONS)) {
    case 'store':
      return await handleMemoryStore(manager, args);
    case 'read':
      return await handleMemoryRead(manager, args);
    case 'update':
      return await handleMemoryUpdate(manager, args);
    case 'search':
      return await handleMemorySearch(manager, args);
    case 'list':
      return await handleMemoryList(manager, args);
    case 'archive':
      return await handleMemoryArchive(manager, args);
  }
}

export async function handleSoulTool(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  switch (requireEnumArg(args, 'action', SOUL_ACTIONS)) {
    case 'get': {
      const soul = await manager.getSoulDocument();
      if (soul === null) {
        return textResult(`No Soul document found.\n\n---\nSession ID: ${SESSION_ID}`);
      }
      const gitId = typeof soul.frontmatter.git_identity === 'string'
        ? `\ngit_identity: ${soul.frontmatter.git_identity}`
        : '';
      return textResult(`${soul.content}\n\n---${gitId}\nSession ID: ${SESSION_ID}`);
    }
    case 'set': {
      const soul = await manager.setSoulDocument(requireStringArg(args, 'content'));
      return textResult(`Soul document written to: ${soul.path}`);
    }
  }
}

export async function handleContextTool(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  requireEnumArg(args, 'action', ['load'] as const);
  const threadId = optionalStringArg(args, 'thread_id');
  const sections = await manager.getContext(
    requireStringArg(args, 'query'),
    { max: optionalNumberArg(args, 'token_budget') ?? DEFAULT_CONTEXT_TOKEN_BUDGET },
    threadId,
  );
  if (sections.length === 0) {
    return textResult('No context found.');
  }

  const contextText = sections
    .map((section) => `### ${section.label}\n${section.content}`)
    .join('\n\n');
  return textResult(`${contextText}\n\n${buildCheckpointReminder(threadId)}`);
}

export async function handleNoteTool(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  switch (requireEnumArg(args, 'action', NOTE_ACTIONS)) {
    case 'create': {
      const notePath = await manager.createNote(
        requireStringArg(args, 'path'),
        requireStringArg(args, 'content'),
      );
      return textResult(`Created note at: ${notePath}`);
    }
    case 'read':
      return textResult(await manager.readNote(requireStringArg(args, 'path')));
    case 'update': {
      const notePath = await manager.updateNote(
        requireStringArg(args, 'path'),
        requireStringArg(args, 'content'),
        optionalStringArg(args, 'expected_current_content'),
      );
      return textResult(`Updated note at: ${notePath}`);
    }
    case 'append': {
      const notePath = await manager.appendNote(
        requireStringArg(args, 'path'),
        requireStringArg(args, 'content'),
        {
          separator: optionalStringArg(args, 'separator'),
          expectedCurrentContent: optionalStringArg(args, 'expected_current_content'),
        },
      );
      return textResult(`Appended to note at: ${notePath}`);
    }
    case 'list': {
      const notes = await manager.listNotes({
        limit: optionalNumberArg(args, 'limit') ?? DEFAULT_LIST_LIMIT,
        prefix: optionalStringArg(args, 'prefix'),
      });
      return textResult(jsonText(notes));
    }
    case 'search': {
      const results = await manager.searchNotes(requireStringArg(args, 'query'), {
        limit: optionalNumberArg(args, 'limit') ?? DEFAULT_SEARCH_LIMIT,
      });
      return textResult(jsonText(results));
    }
    case 'delete': {
      const notePath = await manager.deleteNote(requireStringArg(args, 'path'));
      return textResult(`Deleted note at: ${notePath}`);
    }
  }
}

export async function handleConversationTool(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  requireEnumArg(args, 'action', CONVERSATION_ACTIONS);
  const note = await manager.storeConversation(
    optionalMessagesArg(args, 'messages') ?? [],
    optionalStringArg(args, 'summary'),
    optionalStringArrayArg(args, 'tags') ?? [],
  );
  return textResult(`Saved conversation at: ${note.path}`);
}

export async function handleSkillTool(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  switch (requireEnumArg(args, 'action', SKILL_ACTIONS)) {
    case 'store': {
      const note = await manager.storeSkill(
        requireStringArg(args, 'slug'),
        requireStringArg(args, 'content'),
        optionalStringArrayArg(args, 'tags') ?? [],
      );
      return textResult(`Stored skill at: ${note.path}`);
    }
    case 'get': {
      const slug = requireStringArg(args, 'slug');
      const note = await manager.getSkill(slug);
      return note === null
        ? textResult(`Skill not found: ${slug}`, true)
        : textResult(note.serialize());
    }
    case 'list': {
      const notes = await manager.listSkills();
      const results = notes.map((note) => ({
        slug: note.path.split('/').pop()?.replace(MARKDOWN_SUFFIX_PATTERN, '') ?? note.path,
        tags: note.frontmatter.tags ?? [],
        updated: note.frontmatter.updated,
        preview: note.content.slice(0, SHORT_PREVIEW_LENGTH),
      }));
      return textResult(jsonText(results));
    }
  }
}

export async function handleScratchTool(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  switch (requireEnumArg(args, 'action', SCRATCH_ACTIONS)) {
    case 'append':
      await manager.appendScratch(SESSION_ID, requireStringArg(args, 'content'));
      return textResult('Appended to scratch log.');
    case 'read':
      return await handleScratchRead(manager, args);
    case 'compact':
      return await handleScratchCompact(manager, args);
    case 'prune': {
      const removed = await manager.sweepScratch();
      return textResult(`Pruned ${removed} stale scratch entries.`);
    }
    case 'delete':
      return await handleScratchDelete(manager, args);
    case 'clear':
      await manager.clearScratch();
      return textResult('Cleared scratch log.');
  }
}

async function handleScratchRead(manager: MemoryManager, args: ToolArgs): Promise<ToolResponse> {
  const isBootstrap = optionalBooleanArg(args, 'bootstrap') === true;
  const tokenBudget = optionalNumberArg(args, 'token_budget');
  const entries = await manager.readScratch({
    sessionId: optionalStringArg(args, 'session_id'),
    limit: optionalNumberArg(args, 'limit'),
    since: optionalStringArg(args, 'since'),
    bootstrap: isBootstrap,
  });
  if (entries.length === 0) {
    return textResult('Scratch log is empty.');
  }

  if (isBootstrap) {
    const { included } = renderBootstrapScratch(entries, { tokenBudget, estimateTokens });
    return textResult(included.map(({ rendered }) => rendered).join('\n'));
  }

  return textResult(
    entries.map((entry) => `[${entry.sessionId} | ${entry.timestamp}] ${entry.content}`).join('\n'),
  );
}

async function handleScratchCompact(manager: MemoryManager, args: ToolArgs): Promise<ToolResponse> {
  const sessionId = requireStringArg(args, 'session_id');
  await manager.compactScratch({
    sessionId,
    thresholdMs:
      (optionalNumberArg(args, 'threshold_hours') ?? DEFAULT_SCRATCH_THRESHOLD_HOURS)
      * MILLISECONDS_PER_HOUR,
    compactedContent: requireStringArg(args, 'compacted_content'),
  });
  return textResult(`Compacted scratch entries for session ${sessionId}.`);
}

async function handleScratchDelete(manager: MemoryManager, args: ToolArgs): Promise<ToolResponse> {
  const sessionId = optionalStringArg(args, 'session_id');
  const matchText = optionalStringArg(args, 'match_text');
  if ((sessionId?.length ?? 0) === 0 && (matchText?.length ?? 0) === 0) {
    throw new Error('scratch delete requires at least one filter: session_id or match_text');
  }

  const removed = await manager.deleteScratch({
    sessionId,
    matchText,
    thresholdMs:
      (optionalNumberArg(args, 'threshold_hours') ?? DEFAULT_SCRATCH_THRESHOLD_HOURS)
      * MILLISECONDS_PER_HOUR,
  });
  return textResult(`Deleted ${removed} scratch entr${removed === 1 ? 'y' : 'ies'}.`);
}

async function handleMemoryStore(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  const note = await manager.store(
    requireStringArg(args, 'content'),
    requiredMappedArg(args, 'type', MEMORY_TYPE_MAP),
    {
      tags: optionalStringArrayArg(args, 'tags') ?? [],
      confidence: optionalConfidenceArg(args, 'confidence'),
    },
  );
  const metaUpdates = buildMemoryMetaUpdates(args);
  if (metaUpdates !== undefined) {
    await manager.update(note.path, undefined, metaUpdates);
  }
  return textResult(`Stored memory at: ${note.path}`);
}

async function handleMemoryRead(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  const note = await manager.read(requireStringArg(args, 'path'));
  return textResult(note.serialize());
}

async function handleMemoryUpdate(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  const frontmatterUpdates = buildMemoryFrontmatterUpdates(args);
  const note = await manager.update(
    requireStringArg(args, 'path'),
    optionalStringArg(args, 'content'),
    frontmatterUpdates,
  );
  return textResult(`Updated memory at: ${note.path}`);
}

async function handleMemorySearch(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  const notes = await manager.search(requireStringArg(args, 'query'), {
    type: optionalMappedArg(args, 'type', MEMORY_TYPE_MAP),
    tags: optionalStringArrayArg(args, 'tags'),
    limit: optionalNumberArg(args, 'limit') ?? DEFAULT_SEARCH_LIMIT,
    bootstrap_state: optionalBootstrapStateArg(args, 'bootstrap_state'),
    agent: optionalStringArg(args, 'agent'),
    platform: optionalStringArg(args, 'platform'),
    thread: optionalStringArg(args, 'thread'),
  });
  const results = notes.map((note) => ({
    path: note.path,
    type: note.frontmatter.type,
    state: note.frontmatter.memory_state,
    tags: note.frontmatter.tags ?? [],
    bootstrap_state: note.frontmatter.bootstrap_state,
    agent: note.frontmatter.agent,
    platform: note.frontmatter.platform,
    preview: note.content.slice(0, LONG_PREVIEW_LENGTH),
  }));
  return textResult(jsonText(results));
}

async function handleMemoryList(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  const notes = await manager.list({
    type: optionalMappedArg(args, 'type', MEMORY_TYPE_MAP),
    state: optionalMappedArg(args, 'state', MEMORY_STATE_MAP),
    limit: optionalNumberArg(args, 'limit') ?? DEFAULT_LIST_LIMIT,
    bootstrap_state: optionalBootstrapStateArg(args, 'bootstrap_state'),
    agent: optionalStringArg(args, 'agent'),
    platform: optionalStringArg(args, 'platform'),
    thread: optionalStringArg(args, 'thread'),
  });
  const results = notes.map((note) => ({
    path: note.path,
    type: note.frontmatter.type,
    state: note.frontmatter.memory_state,
    tags: note.frontmatter.tags ?? [],
    created: note.frontmatter.created,
    bootstrap_state: note.frontmatter.bootstrap_state,
    agent: note.frontmatter.agent,
    platform: note.frontmatter.platform,
    preview: note.content.slice(0, SHORT_PREVIEW_LENGTH),
  }));
  return textResult(jsonText(results));
}

async function handleMemoryArchive(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  const archived = await manager.archiveForgotten(optionalNumberArg(args, 'older_than_days'));
  const message = archived.length === 0
    ? 'No forgotten notes matched the criteria.'
    : `Archived ${archived.length} forgotten note(s):\n${archived.join('\n')}`;
  return textResult(message);
}

function buildMemoryFrontmatterUpdates(
  args: ToolArgs,
): Record<string, unknown> | undefined {
  const frontmatterUpdates: Record<string, unknown> = {};
  assignIfPresent(frontmatterUpdates, 'type', optionalMappedArg(args, 'type', MEMORY_TYPE_MAP));
  assignIfPresent(frontmatterUpdates, 'tags', optionalStringArrayArg(args, 'tags'));
  assignIfPresent(frontmatterUpdates, 'memory_state', optionalMappedArg(args, 'state', MEMORY_STATE_MAP));
  assignIfPresent(frontmatterUpdates, 'session_id', optionalStringArg(args, 'session_id'));
  assignIfPresent(frontmatterUpdates, 'bootstrap_state', optionalBootstrapStateArg(args, 'bootstrap_state'));
  assignIfPresent(frontmatterUpdates, 'agent', optionalStringArg(args, 'agent'));
  assignIfPresent(frontmatterUpdates, 'platform', optionalStringArg(args, 'platform'));
  assignIfPresent(frontmatterUpdates, 'summary', optionalStringArg(args, 'summary'));
  assignIfPresent(frontmatterUpdates, 'thread', optionalStringArg(args, 'thread'));
  return Object.keys(frontmatterUpdates).length === 0 ? undefined : frontmatterUpdates;
}

function buildMemoryMetaUpdates(args: ToolArgs): Record<string, unknown> | undefined {
  const metaUpdates: Record<string, unknown> = {};
  assignIfRequested(metaUpdates, args, {
    targetKey: 'memory_state',
    argKey: 'state',
    value: optionalStringArg(args, 'state'),
  });
  assignIfRequested(metaUpdates, args, {
    targetKey: 'session_id',
    argKey: 'session_id',
    value: optionalStringArg(args, 'session_id'),
  });
  assignIfRequested(metaUpdates, args, {
    targetKey: 'bootstrap_state',
    argKey: 'bootstrap_state',
    value: optionalBootstrapStateArg(args, 'bootstrap_state'),
  });
  assignIfRequested(metaUpdates, args, {
    targetKey: 'agent',
    argKey: 'agent',
    value: optionalStringArg(args, 'agent'),
  });
  assignIfRequested(metaUpdates, args, {
    targetKey: 'platform',
    argKey: 'platform',
    value: optionalStringArg(args, 'platform'),
  });
  assignIfRequested(metaUpdates, args, {
    targetKey: 'summary',
    argKey: 'summary',
    value: optionalStringArg(args, 'summary'),
  });
  assignIfRequested(metaUpdates, args, {
    targetKey: 'thread',
    argKey: 'thread',
    value: optionalStringArg(args, 'thread'),
  });
  return Object.keys(metaUpdates).length === 0 ? undefined : metaUpdates;
}

function assignIfPresent(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined) {
    const next = target;
    next[key] = value;
  }
}

function assignIfRequested(
  target: Record<string, unknown>,
  args: ToolArgs,
  entry: {
    readonly argKey: string;
    readonly targetKey: string;
    readonly value: unknown;
  },
): void {
  const {
    argKey,
    targetKey,
    value,
  } = entry;
  if (hasOwnArg(args, argKey)) {
    const next = target;
    next[targetKey] = value;
  }
}
