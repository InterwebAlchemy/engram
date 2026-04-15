import type {
  DreamsAction,
  DreamsExecutionResult,
  DreamsReport,
} from './types';

const CODE_FENCE_PATTERN = /^```(?:json)?\s*(?<body>[\s\S]*?)\s*```$/iu;
const ACTIONS_ARRAY_START_PATTERN = /"actions"\s*:\s*\[/u;

export interface ParsedDreamsResponse {
  actions: DreamsAction[];
  dream?: string;
}

export function buildDryRunExecution(actions: DreamsAction[]): DreamsExecutionResult {
  return {
    dryRun: true,
    applied: 0,
    skipped: actions.length,
    details: actions.map((action) => `[dry-run] ${describeAction(action)}`),
  };
}

export function protectCoreMemoryActions(
  actions: DreamsAction[],
  report: DreamsReport,
): DreamsAction[] {
  const corePaths = new Set(report.stateDistribution.memoriesByState.core.map((entry) => entry.path));
  if (corePaths.size === 0) {
    return actions;
  }

  return actions.flatMap((action) => convertCoreMutationToReviewFlag(action, corePaths));
}

export function parseDreamsResponse(rawResponse: string): ParsedDreamsResponse {
  const trimmedResponse = rawResponse.trim();
  const fenceMatch = CODE_FENCE_PATTERN.exec(trimmedResponse);
  const candidate = fenceMatch?.groups?.body ?? extractJSONBody(trimmedResponse);
  const parsed = tryParseJSON(candidate);

  if (Array.isArray(parsed)) {
    return { actions: normalizeDreamsActions(parsed) };
  }

  if (isRecord(parsed) && Array.isArray(parsed.actions)) {
    return { actions: normalizeDreamsActions(parsed.actions) };
  }

  throw new Error('Dreams provider response was not a recognized format.');
}

export function describeAction(action: DreamsAction): string {
  switch (action.action) {
    case 'update_state':
      return `update_state ${action.path}: ${action.from} -> ${action.to}`;
    case 'set_thread':
      return `set_thread ${action.path}: ${action.thread_id}`;
    case 'rewrite_thread':
      return `rewrite_thread ${action.thread_id}`;
    case 'update_thread_status':
      return `update_thread_status ${action.thread_id}: ${action.from} -> ${action.to}`;
    case 'merge_threads':
      return `merge_threads ${action.source_thread_id} -> ${action.target_thread_id}`;
    case 'merge':
      return `merge keep=${action.keep} remove=${action.remove.join(', ')}`;
    case 'update_summary':
      return `update_summary ${action.path}`;
    case 'update_type':
      return `update_type ${action.path}: ${action.from} -> ${action.to}`;
    case 'rewrite_content':
      return `rewrite_content ${action.path}`;
    case 'forget':
      return `forget ${action.path}`;
    case 'compact_scratch':
      return `compact_scratch ${action.session_id}`;
    case 'archive_forgotten':
      return 'archive_forgotten';
    case 'flag_core_review':
      return `flag_core_review ${action.path}: ${action.concern}`;
  }
}

function convertCoreMutationToReviewFlag(
  action: DreamsAction,
  corePaths: Set<string>,
): DreamsAction[] {
  if (action.action === 'flag_core_review') {
    return [action];
  }

  const affectedCorePaths = getAffectedCorePaths(action, corePaths);
  if (affectedCorePaths.length === 0) {
    return [action];
  }

  return affectedCorePaths.map((path) => ({
    action: 'flag_core_review',
    path,
    concern: 'Core memory may need a manual update based on Dream analysis.',
    suggested_change: describeAction(action),
    reason: hasReason(action)
      ? action.reason
      : 'Dreams does not mutate core memories automatically; review this note manually.',
  }));
}

function getAffectedCorePaths(action: DreamsAction, corePaths: Set<string>): string[] {
  switch (action.action) {
    case 'update_state':
    case 'set_thread':
    case 'update_summary':
    case 'update_type':
    case 'rewrite_content':
    case 'forget':
    case 'flag_core_review':
      return corePaths.has(action.path) ? [action.path] : [];
    case 'merge':
      return [action.keep, ...action.remove].filter((path) => corePaths.has(path));
    case 'rewrite_thread':
    case 'update_thread_status':
    case 'merge_threads':
    case 'compact_scratch':
    case 'archive_forgotten':
      return [];
  }
}

function hasReason(action: DreamsAction): action is Extract<DreamsAction, { reason: string }> {
  return 'reason' in action && typeof action.reason === 'string';
}

function extractJSONBody(text: string): string {
  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  if (objectStart !== -1 && objectEnd > objectStart) {
    return text.slice(objectStart, objectEnd + 1);
  }

  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');
  if (arrayStart !== -1 && arrayEnd > arrayStart) {
    return text.slice(arrayStart, arrayEnd + 1);
  }

  throw new Error('Could not find JSON in Dreams provider response.');
}

function tryParseJSON(candidate: string): unknown {
  try {
    return JSON.parse(candidate) as unknown;
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }

    return repairTruncatedDreamsResponse(candidate);
  }
}

function repairTruncatedDreamsResponse(candidate: string): { actions: unknown[] } {
  const actionsMatch = ACTIONS_ARRAY_START_PATTERN.exec(candidate);
  if (actionsMatch === null) {
    throw new Error('Dreams response is not valid JSON and could not be repaired.');
  }

  const arrayStart = actionsMatch.index + actionsMatch[0].length - 1;
  const lastCompleteElement = findLastCompleteActionIndex(candidate, arrayStart);
  if (lastCompleteElement === null) {
    throw new Error('Dreams response is not valid JSON and could not be repaired.');
  }

  const repairedArray = `${candidate.slice(arrayStart, lastCompleteElement + 1)}]`;
  const actions = JSON.parse(repairedArray) as unknown;
  if (!Array.isArray(actions)) {
    throw new Error('Dreams response repair produced a non-array actions payload.');
  }

  return { actions };
}

function findLastCompleteActionIndex(candidate: string, arrayStart: number): number | null {
  let depth = 0;
  let index = arrayStart;
  let lastCompleteElement: number | null = null;

  while (index < candidate.length) {
    const character = candidate.at(index);
    if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        lastCompleteElement = index;
      }
    }

    index += 1;
  }

  return lastCompleteElement;
}

function normalizeDreamsActions(rawActions: unknown[]): DreamsAction[] {
  const issues: string[] = [];
  const actions: DreamsAction[] = [];

  for (const [index, rawAction] of rawActions.entries()) {
    try {
      actions.push(normalizeDreamAction(rawAction, index + 1));
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'Unknown Dreams action parse error.');
    }
  }

  if (issues.length > 0) {
    throw new Error(`Dreams response contained invalid actions: ${issues.join(' | ')}`);
  }

  return actions;
}

function normalizeDreamAction(rawAction: unknown, actionIndex: number): DreamsAction {
  const record = asRecord(rawAction, `Dreams action #${actionIndex} must be an object.`);
  const actionName = readString(record, ['action', 'type']);
  if (actionName === undefined || actionName.length === 0) {
    throw new Error(`Dreams action #${actionIndex} is missing an action name.`);
  }

  switch (actionName) {
    case 'update_state':
      return {
        action: 'update_state',
        path: requireString(record, ['path'], actionIndex),
        from: requireString(record, ['from'], actionIndex),
        to: requireString(record, ['to'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'set_thread':
      return {
        action: 'set_thread',
        path: requireString(record, ['path'], actionIndex),
        thread_id: requireString(record, ['thread_id', 'threadId'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'rewrite_thread':
      return {
        action: 'rewrite_thread',
        thread_id: requireString(record, ['thread_id', 'threadId'], actionIndex),
        content: requireString(record, ['content'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'update_thread_status':
      return {
        action: 'update_thread_status',
        thread_id: requireString(record, ['thread_id', 'threadId'], actionIndex),
        from: requireString(record, ['from'], actionIndex),
        to: requireString(record, ['to'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'merge_threads':
      return {
        action: 'merge_threads',
        source_thread_id: requireString(record, ['source_thread_id', 'sourceThreadId'], actionIndex),
        target_thread_id: requireString(record, ['target_thread_id', 'targetThreadId'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'merge':
      return {
        action: 'merge',
        keep: requireString(record, ['keep'], actionIndex),
        remove: requireStringArray(record, ['remove'], actionIndex),
        merged_content: requireString(record, ['merged_content', 'mergedContent'], actionIndex),
        merged_summary: requireString(record, ['merged_summary', 'mergedSummary'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'update_summary':
      return {
        action: 'update_summary',
        path: requireString(record, ['path'], actionIndex),
        summary: requireString(record, ['summary'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'update_type':
      return {
        action: 'update_type',
        path: requireString(record, ['path'], actionIndex),
        from: requireString(record, ['from'], actionIndex),
        to: requireString(record, ['to'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'rewrite_content':
      return {
        action: 'rewrite_content',
        path: requireString(record, ['path'], actionIndex),
        content: requireString(record, ['content'], actionIndex),
        summary: requireString(record, ['summary'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'forget':
      return {
        action: 'forget',
        path: requireString(record, ['path'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    case 'compact_scratch':
      return {
        action: 'compact_scratch',
        session_id: requireString(record, ['session_id', 'sessionId'], actionIndex),
        summary: requireString(record, ['summary'], actionIndex),
      };
    case 'archive_forgotten':
      return { action: 'archive_forgotten' };
    case 'flag_core_review':
      return {
        action: 'flag_core_review',
        path: requireString(record, ['path'], actionIndex),
        concern: requireString(record, ['concern'], actionIndex),
        suggested_change: requireString(record, ['suggested_change', 'suggestedChange'], actionIndex),
        reason: requireString(record, ['reason'], actionIndex),
      };
    default:
      throw new Error(`Dreams action #${actionIndex} has unknown action "${actionName}".`);
  }
}

function asRecord(value: unknown, errorMessage: string): Record<string, unknown> {
  if (!isRecord(value) || Array.isArray(value)) {
    throw new Error(errorMessage);
  }

  return value;
}

function readString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const { [key]: value } = record;
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }

  return undefined;
}

function requireString(
  record: Record<string, unknown>,
  keys: string[],
  actionIndex: number,
): string {
  const value = readString(record, keys);
  if (value !== undefined && value.length > 0) {
    return value;
  }

  throw new Error(
    `Dreams action #${actionIndex} is missing ${keys.map((key) => `"${key}"`).join(' or ')}.`,
  );
}

function requireStringArray(
  record: Record<string, unknown>,
  keys: string[],
  actionIndex: number,
): string[] {
  for (const key of keys) {
    const { [key]: value } = record;
    if (Array.isArray(value)) {
      const items = value.filter(
        (item): item is string => typeof item === 'string' && item.trim().length > 0,
      );
      if (items.length > 0) {
        return items;
      }
    }

    if (typeof value === 'string' && value.trim().length > 0) {
      return [value];
    }
  }

  throw new Error(
    `Dreams action #${actionIndex} is missing ${keys.map((key) => `"${key}"`).join(' or ')}.`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
