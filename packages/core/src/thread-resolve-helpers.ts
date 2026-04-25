import { readNonEmptyString, readStringArray } from './memory-helpers.js';
import { resolveThreadIdOrThrow, type ThreadMatch } from './thread-helpers.js';
import type { NoteFrontmatter, ThreadFields } from './types.js';
import type { VaultNote } from './vault.js';

export interface ResolvedThreadCandidate {
  threadId: string;
  name: string;
  reason: 'path' | 'remote' | 'package' | 'related';
}

const MAX_FORWARD_HOPS = 5;

export function describeRelatedThreadCandidates(
  resolved: VaultNote,
  threads: VaultNote[],
  suppress: Set<string>,
): ResolvedThreadCandidate[] {
  const relatedIds = readStringArray(resolved.frontmatter.related_threads);
  if (relatedIds.length === 0) {
    return [];
  }

  const lookup = buildThreadLookup(threads);
  const candidates: ResolvedThreadCandidate[] = [];
  const seen = new Set<string>();
  for (const ref of relatedIds) {
    const candidate = resolveRelatedCandidate(ref, lookup, suppress, seen);
    if (candidate !== null) {
      seen.add(candidate.threadId);
      candidates.push(candidate);
    }
  }
  return candidates;
}

interface ThreadLookup {
  byId: Map<string, VaultNote>;
  byAlias: Map<string, VaultNote>;
}

function buildThreadLookup(threads: VaultNote[]): ThreadLookup {
  const byId = new Map<string, VaultNote>();
  const byAlias = new Map<string, VaultNote>();
  for (const thread of threads) {
    const id = readNonEmptyString(thread.frontmatter.thread_id);
    if (id !== null) {
      byId.set(id, thread);
    }
    for (const alias of readStringArray(thread.frontmatter.aliases)) {
      byAlias.set(alias, thread);
    }
  }
  return { byId, byAlias };
}

function resolveRelatedCandidate(
  ref: string,
  lookup: ThreadLookup,
  suppress: Set<string>,
  seen: Set<string>,
): ResolvedThreadCandidate | null {
  const target = lookup.byId.get(ref) ?? lookup.byAlias.get(ref) ?? null;
  if (target === null) {
    return null;
  }
  const targetId = readNonEmptyString(target.frontmatter.thread_id);
  if (targetId === null || suppress.has(targetId) || seen.has(targetId)) {
    return null;
  }
  return {
    threadId: targetId,
    name: readNonEmptyString(target.frontmatter.name) ?? targetId,
    reason: 'related',
  };
}

export function describeAlternateCandidates(
  matches: ThreadMatch[],
  suppress: Set<string>,
): ResolvedThreadCandidate[] {
  const candidates: ResolvedThreadCandidate[] = [];
  for (const match of matches) {
    const threadId = readNonEmptyString(match.thread.frontmatter.thread_id);
    if (threadId === null || suppress.has(threadId)) {
      continue;
    }
    candidates.push({
      threadId,
      name: readNonEmptyString(match.thread.frontmatter.name) ?? threadId,
      reason: reasonFor(match),
    });
  }
  return candidates;
}

function reasonFor(match: ThreadMatch): ResolvedThreadCandidate['reason'] {
  if (match.pathScore !== null) {
    return 'path';
  }
  if (match.remoteMatched) {
    return 'remote';
  }
  return 'package';
}

export function followSupersededBy(
  start: VaultNote,
  threads: VaultNote[],
): { resolved: VaultNote; chain: string[] } {
  const byId = new Map<string, VaultNote>();
  for (const thread of threads) {
    const id = readNonEmptyString(thread.frontmatter.thread_id);
    if (id !== null) {
      byId.set(id, thread);
    }
  }

  const chain: string[] = [];
  let current = start;
  const seen = new Set<string>([resolveThreadIdOrThrow(start)]);
  while (chain.length < MAX_FORWARD_HOPS) {
    const next = resolveForwardTarget(current, byId, seen);
    if (next === null) {
      break;
    }
    chain.push(resolveThreadIdOrThrow(current));
    seen.add(resolveThreadIdOrThrow(next));
    current = next;
  }
  return { resolved: current, chain };
}

function resolveForwardTarget(
  current: VaultNote,
  byId: Map<string, VaultNote>,
  seen: Set<string>,
): VaultNote | null {
  const forwardTo = readNonEmptyString(current.frontmatter.superseded_by);
  if (forwardTo === null || seen.has(forwardTo)) {
    return null;
  }
  return byId.get(forwardTo) ?? null;
}

export function computeSuppressedIds(
  threads: VaultNote[],
  finalId: string,
  chain: string[],
): Set<string> {
  const suppress = new Set<string>([finalId, ...chain]);
  for (const thread of threads) {
    const forwardsTo = readNonEmptyString(thread.frontmatter.superseded_by);
    if (forwardsTo !== null && suppress.has(forwardsTo)) {
      const id = readNonEmptyString(thread.frontmatter.thread_id);
      if (id !== null) {
        suppress.add(id);
      }
    }
  }
  return suppress;
}

export function parseLastActiveMs(value: unknown): number {
  if (typeof value !== 'string') {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

const FIELD_UPDATE_KEYS: ReadonlyArray<keyof ThreadFields> = [
  'name',
  'description',
  'goals',
  'paths',
  'repositories',
  'packages',
  'aliases',
  'superseded_by',
  'related_threads',
  'tags',
];

export function collectFieldUpdates(fields: ThreadFields): Partial<NoteFrontmatter> {
  return Object.fromEntries(
    FIELD_UPDATE_KEYS
      .map((key) => [key, fields[key]] as const)
      .filter((entry): entry is readonly [keyof ThreadFields, NonNullable<ThreadFields[keyof ThreadFields]>] => entry[1] !== undefined),
  );
}
