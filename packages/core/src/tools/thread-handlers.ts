import type { MemoryManager } from '../memory.js';
import type { ResolvedThread } from '../thread-operations.js';
import type { ThreadStatus } from '../types.js';
import type { VaultNote } from '../vault.js';
import { THREAD_STATUS_MAP } from './definitions.js';
import {
  type ToolArgs,
  type ToolResponse,
  jsonText,
  optionalBooleanArg,
  optionalMappedArg,
  optionalStringArg,
  optionalStringArrayArg,
  requireEnumArg,
  requireStringArg,
  textResult,
} from './args.js';

const INBOX_ACTIONS = ['list', 'add', 'read', 'remove'] as const;
const THREAD_ACTIONS = [
  'get',
  'set',
  'update',
  'list',
  'resolve',
  'merge',
  'todo_list',
  'todo_add',
  'todo_complete',
  'todo_reopen',
  'todo_remove',
] as const;

export async function handleThreadTool(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  switch (requireEnumArg(args, 'action', THREAD_ACTIONS)) {
    case 'get': {
      const threadId = requireStringArg(args, 'thread_id');
      const thread = await manager.getThread(threadId);
      return thread === null
        ? textResult(`Thread not found: ${threadId}`, true)
        : textResult(thread.serialize());
    }
    case 'set': {
      const thread = await manager.setThread(
        requireStringArg(args, 'thread_id'),
        requireStringArg(args, 'content'),
        buildThreadFields(args),
      );
      return textResult(`Thread written to: ${thread.path}`);
    }
    case 'update': {
      const thread = await manager.updateThread(
        requireStringArg(args, 'thread_id'),
        optionalStringArg(args, 'content'),
        buildThreadFields(args),
      );
      return textResult(`Thread updated at: ${thread.path}`);
    }
    case 'list': {
      const threads = await manager.listThreads();
      const results = threads.map((thread) => ({
        thread_id: thread.frontmatter.thread_id,
        name: thread.frontmatter.name,
        status: thread.frontmatter.status,
        description: thread.frontmatter.description,
        goals: thread.frontmatter.goals ?? [],
        paths: thread.frontmatter.paths ?? [],
        repositories: thread.frontmatter.repositories ?? [],
        related_threads: thread.frontmatter.related_threads ?? [],
        updated: thread.frontmatter.updated,
      }));
      return textResult(jsonText(results));
    }
    case 'resolve': {
      const result = await manager.resolveThread({
        cwd: optionalStringArg(args, 'cwd'),
        gitRemote: optionalStringArg(args, 'git_remote'),
        autoCreate: optionalBooleanArg(args, 'auto_create'),
      });
      return textResult(formatResolvedThread(result));
    }
    case 'merge': {
      const sourceThreadId = requireStringArg(args, 'source_thread_id');
      const targetThreadId = requireStringArg(args, 'target_thread_id');
      const result = await manager.mergeThreads(sourceThreadId, targetThreadId);
      return textResult(jsonText({
        source_thread_id: sourceThreadId,
        target_thread_id: targetThreadId,
        retagged_count: result.retaggedCount,
        source_status: 'closed',
      }));
    }
    case 'todo_list': {
      const todos = await manager.listThreadTodos(
        requireStringArg(args, 'thread_id'),
        { includeCompleted: optionalBooleanArg(args, 'include_completed') },
      );
      return textResult(jsonText(todos));
    }
    case 'todo_add': {
      const thread = await manager.addThreadTodo(
        requireStringArg(args, 'thread_id'),
        requireStringArg(args, 'item'),
        { prepend: optionalBooleanArg(args, 'prepend') },
      );
      return textResult(`Thread todo updated at: ${thread.path}`);
    }
    case 'todo_complete': {
      const thread = await manager.completeThreadTodo(
        requireStringArg(args, 'thread_id'),
        requireStringArg(args, 'item'),
      );
      return textResult(`Thread todo completed at: ${thread.path}`);
    }
    case 'todo_reopen': {
      const thread = await manager.reopenThreadTodo(
        requireStringArg(args, 'thread_id'),
        requireStringArg(args, 'item'),
      );
      return textResult(`Thread todo reopened at: ${thread.path}`);
    }
    case 'todo_remove': {
      const thread = await manager.removeThreadTodo(
        requireStringArg(args, 'thread_id'),
        requireStringArg(args, 'item'),
      );
      return textResult(`Thread todo removed at: ${thread.path}`);
    }
  }
}

export async function handleInboxTool(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  switch (requireEnumArg(args, 'action', INBOX_ACTIONS)) {
    case 'list':
      return await handleInboxList(manager, args);
    case 'add':
      return await handleInboxAdd(manager, args);
    case 'read': {
      const itemPath = requireStringArg(args, 'path');
      const content = await manager.readNote(itemPath);
      return textResult(content);
    }
    case 'remove':
      return await handleInboxRemove(manager, args);
  }
}

function buildThreadFields(args: ToolArgs): {
  description?: string;
  goals?: string[];
  name?: string;
  paths?: string[];
  repositories?: string[];
  related_threads?: string[];
  status?: ThreadStatus;
  tags?: string[];
} {
  return {
    name: optionalStringArg(args, 'name'),
    description: optionalStringArg(args, 'description'),
    status: optionalMappedArg(args, 'status', THREAD_STATUS_MAP),
    goals: optionalStringArrayArg(args, 'goals'),
    paths: optionalStringArrayArg(args, 'paths'),
    repositories: optionalStringArrayArg(args, 'repositories'),
    related_threads: optionalStringArrayArg(args, 'related_threads'),
    tags: optionalStringArrayArg(args, 'tags'),
  };
}

async function handleInboxList(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  const threadId = optionalStringArg(args, 'thread_id');
  if (threadId !== undefined && threadId.length > 0) {
    return textResult(jsonText(await manager.listThreadInbox(threadId)));
  }
  return textResult(jsonText(await manager.listGlobalInbox()));
}

async function handleInboxAdd(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  const content = requireStringArg(args, 'content');
  const threadId = optionalStringArg(args, 'thread_id');
  if (threadId !== undefined && threadId.length > 0) {
    const itemPath = await manager.addThreadInboxItem(threadId, content);
    return textResult(`Inbox item created at: ${itemPath}`);
  }

  const name = optionalStringArg(args, 'name');
  const itemPath = await manager.addGlobalInboxItem(content, name);
  return textResult(`Inbox item created at: ${itemPath}`);
}

async function handleInboxRemove(
  manager: MemoryManager,
  args: ToolArgs,
): Promise<ToolResponse> {
  const itemPath = optionalStringArg(args, 'path');
  const threadId = optionalStringArg(args, 'thread_id');
  if (itemPath !== undefined && itemPath.length > 0) {
    const removed = await manager.removeInboxItem(itemPath);
    return textResult(`Inbox item removed: ${removed}`);
  }
  if (threadId !== undefined && threadId.length > 0) {
    return textResult('`path` is required for `remove`.', true);
  }
  return textResult('`path` is required for `remove`.', true);
}

function appendThreadMeta(lines: string[], frontmatter: VaultNote['frontmatter'], threadId: string): void {
  const { name, description, goals } = frontmatter;
  if (typeof name === 'string' && name.length > 0 && name !== threadId) {
    lines.push(`name: ${name}`);
  }
  if (typeof description === 'string' && description.length > 0) {
    lines.push(`description: ${description}`);
  }
  if (Array.isArray(goals) && goals.length > 0) {
    lines.push('goals:');
    for (const g of goals) {
      lines.push(`- ${String(g)}`);
    }
  }
}

function formatResolvedThread(result: ResolvedThread): string {
  const { threadId, created, thread, candidates } = result;
  const lines: string[] = [`thread_id: ${threadId} (${created ? 'created' : 'found'})`];
  appendThreadMeta(lines, thread.frontmatter, threadId);
  if (candidates !== undefined && candidates.length > 0) {
    lines.push('other_candidates:');
    for (const candidate of candidates) {
      lines.push(`- ${candidate.threadId} (${candidate.name}) [${candidate.reason}]`);
    }
    lines.push('If one of the above is the intended thread, use thread(action: "merge") or re-resolve with an explicit thread_id.');
  }
  const body = thread.content.trim();
  if (body.length > 0) {
    lines.push('', body);
  }
  return lines.join('\n');
}
