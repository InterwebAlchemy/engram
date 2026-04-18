import * as path from 'node:path';
import {
  MemoryState,
  type FileSystemAdapter,
  type MemoryManager,
} from '@interwebalchemy/engram-core';
import { readMemoryState, readThreadStatus } from './analyzer-utils';
import { describeAction } from './runner-response';
import type {
  DreamsAction,
  DreamsExecutionResult,
} from './types';

const TYPE_DIRECTORIES: Record<string, string> = {
  fact: 'facts',
  entity: 'entities',
  reflection: 'reflections',
  skill: 'skills',
};
const INITIAL_UNIQUE_PATH_SUFFIX = 2;

interface ExecuteDreamsActionsOptions {
  actions: DreamsAction[];
  adapter: FileSystemAdapter;
  archivePath: string;
  engramRoot: string;
  manager: MemoryManager;
  vaultBasePath: string;
}

export async function executeDreamsActions(
  options: ExecuteDreamsActionsOptions,
): Promise<DreamsExecutionResult> {
  const initialState: DreamsExecutionResult = {
    dryRun: false,
    applied: 0,
    skipped: 0,
    details: [],
  };

  return await options.actions.reduce(
    async (statePromise, action) => {
      const state = await statePromise;
      const result = await executeDreamAction(action, options);

      return {
        dryRun: false,
        applied: state.applied + result.applied,
        skipped: state.skipped + result.skipped,
        details: [...state.details, result.detail],
      };
    },
    Promise.resolve(initialState),
  );
}

async function executeDreamAction(
  action: DreamsAction,
  options: ExecuteDreamsActionsOptions,
): Promise<{ applied: number; detail: string; skipped: number }> {
  switch (action.action) {
    case 'update_state':
      await options.manager.update(action.path, undefined, {
        memory_state: readMemoryState(action.to),
      });
      return appliedAction(action);
    case 'set_thread':
      await options.manager.update(action.path, undefined, { thread: action.thread_id });
      return appliedAction(action);
    case 'rewrite_thread':
      await options.manager.updateThread(action.thread_id, action.content);
      return appliedAction(action);
    case 'update_thread_status':
      await options.manager.updateThread(action.thread_id, undefined, {
        status: readThreadStatus(action.to),
      });
      return appliedAction(action);
    case 'merge_threads':
      await options.manager.mergeThreads(action.source_thread_id, action.target_thread_id);
      return appliedAction(action);
    case 'update_summary':
      await options.manager.update(action.path, undefined, { summary: action.summary });
      return appliedAction(action);
    case 'rewrite_content':
      await options.manager.update(action.path, action.content, { summary: action.summary });
      return appliedAction(action);
    case 'forget':
      await options.manager.update(action.path, undefined, { memory_state: MemoryState.Forgotten });
      return appliedAction(action);
    case 'update_type':
      await moveNoteToTypePath({
        adapter: options.adapter,
        engramRoot: options.engramRoot,
        manager: options.manager,
        newType: action.to,
        notePath: action.path,
        vaultBasePath: options.vaultBasePath,
      });
      return appliedAction(action);
    case 'merge':
      await mergeNotes({
        action,
        adapter: options.adapter,
        archivePath: options.archivePath,
        engramRoot: options.engramRoot,
        manager: options.manager,
        vaultBasePath: options.vaultBasePath,
      });
      return appliedAction(action);
    case 'archive_forgotten':
      await options.manager.archiveForgotten();
      return appliedAction(action);
    case 'flag_core_review':
      return appliedAction(action);
  }
}

async function moveNoteToTypePath(options: {
  adapter: FileSystemAdapter;
  engramRoot: string;
  manager: MemoryManager;
  newType: string;
  notePath: string;
  vaultBasePath: string;
}): Promise<void> {
  const {
    adapter,
    engramRoot,
    manager,
    newType,
    notePath,
    vaultBasePath,
  } = options;
  const note = await manager.read(notePath);
  const expectedDir = expectedDirectoryForType(newType);
  if (expectedDir === undefined) {
    await manager.update(notePath, undefined, { type: newType });
    return;
  }

  const writeRoot = path.join(vaultBasePath, engramRoot);
  const fileName = path.basename(note.path);
  const targetDir = path.join(writeRoot, 'memory', expectedDir);
  const targetPath = await resolveUniquePath({
    adapter: options.adapter,
    currentPath: note.path,
    desiredPath: path.join(targetDir, fileName),
  });

  if (targetPath === note.path) {
    await manager.update(notePath, undefined, { type: newType });
    return;
  }

  note.path = targetPath;
  note.updateFrontmatter({ type: newType });
  await adapter.mkdir(targetDir);
  await note.save(adapter);
  await adapter.delete(notePath);
}

async function mergeNotes(options: {
  action: Extract<DreamsAction, { action: 'merge' }>;
  adapter: FileSystemAdapter;
  archivePath: string;
  engramRoot: string;
  manager: MemoryManager;
  vaultBasePath: string;
}): Promise<void> {
  const { action } = options;
  await options.manager.update(action.keep, action.merged_content, {
    summary: action.merged_summary,
  });

  await action.remove.reduce(
    async (promise, removePath) => {
      await promise;
      if (removePath === action.keep) {
        return;
      }

      const note = await options.manager.read(removePath);
      const writeRoot = path.join(options.vaultBasePath, options.engramRoot);
      const relativePath = path.relative(writeRoot, note.path);
      const archiveTarget = await resolveUniquePath({
        adapter: options.adapter,
        currentPath: '',
        desiredPath: path.join(writeRoot, options.archivePath, relativePath),
      });
      await options.adapter.mkdir(path.dirname(archiveTarget));
      await options.adapter.write(archiveTarget, note.serialize());
      await options.adapter.delete(note.path);
    },
    Promise.resolve(),
  );
}

async function resolveUniquePath(options: {
  adapter: FileSystemAdapter;
  currentPath: string;
  desiredPath: string;
  attempt?: number;
}): Promise<string> {
  const attempt = options.attempt ?? INITIAL_UNIQUE_PATH_SUFFIX;
  if (options.desiredPath === options.currentPath) {
    return options.desiredPath;
  }

  if (!(await options.adapter.exists(options.desiredPath))) {
    return options.desiredPath;
  }

  const parsedPath = path.parse(options.desiredPath);
  return await resolveUniquePath({
    adapter: options.adapter,
    currentPath: options.currentPath,
    desiredPath: path.join(
      parsedPath.dir,
      `${parsedPath.name}-${attempt}${parsedPath.ext}`,
    ),
    attempt: attempt + 1,
  });
}

function appliedAction(action: DreamsAction): { applied: number; detail: string; skipped: number } {
  return {
    applied: 1,
    skipped: 0,
    detail: describeAction(action),
  };
}

function expectedDirectoryForType(type: string): string | undefined {
  return TYPE_DIRECTORIES[type];
}
