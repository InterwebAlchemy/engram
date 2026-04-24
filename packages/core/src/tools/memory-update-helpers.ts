import {
  MEMORY_STATE_MAP,
  MEMORY_TYPE_MAP,
} from './definitions.js';
import {
  type ToolArgs,
  hasOwnArg,
  optionalBootstrapStateArg,
  optionalMappedArg,
  optionalStringArg,
  optionalStringArrayArg,
} from './args.js';

export function buildMemoryFrontmatterUpdates(
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

export function buildMemoryMetaUpdates(args: ToolArgs): Record<string, unknown> | undefined {
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
  const { argKey, targetKey, value } = entry;
  if (hasOwnArg(args, argKey)) {
    const next = target;
    next[targetKey] = value;
  }
}
