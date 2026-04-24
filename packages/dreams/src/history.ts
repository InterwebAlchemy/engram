import * as path from 'node:path';
import type { FileSystemAdapter } from '@interwebalchemy/engram-core';
import type {
  DreamsRunHistory,
  DreamsRunRecord,
  DreamsUsageTrend,
} from './types.js';

const HISTORY_FILE = 'token-usage-history.json';
const HISTORY_VERSION = 1;
const JSON_INDENT = 2;
const DEFAULT_BASELINE_COUNT = 3;
const DEFAULT_RECENT_COUNT = 3;

interface DreamsHistoryLocation {
  basePath: string;
  engramRoot: string;
  workingPath: string;
}

interface AppendDreamsRunHistoryOptions extends DreamsHistoryLocation {
  record: DreamsRunRecord;
}

export async function readDreamsRunHistory(
  adapter: FileSystemAdapter,
  basePath: string,
  engramRoot: string,
  workingPath: string,
): Promise<DreamsRunHistory> {
  const location = { basePath, engramRoot, workingPath };
  const filePath = getDreamsRunHistoryPath(location);

  try {
    return parseDreamsRunHistory(await adapter.read(filePath));
  } catch {
    return createEmptyHistory();
  }
}

export async function appendDreamsRunHistory(
  adapter: FileSystemAdapter,
  options: AppendDreamsRunHistoryOptions,
): Promise<DreamsRunHistory> {
  const filePath = getDreamsRunHistoryPath(options);
  const history = await readDreamsRunHistory(
    adapter,
    options.basePath,
    options.engramRoot,
    options.workingPath,
  );
  const next: DreamsRunHistory = {
    version: HISTORY_VERSION,
    updatedAt: new Date().toISOString(),
    runs: [...history.runs, options.record],
  };

  await adapter.mkdir(path.dirname(filePath));
  await adapter.write(filePath, `${JSON.stringify(next, null, JSON_INDENT)}\n`);

  return next;
}

export function summarizeDreamsUsage(
  history: DreamsRunHistory,
  baselineCount = DEFAULT_BASELINE_COUNT,
  recentCount = DEFAULT_RECENT_COUNT,
): DreamsUsageTrend {
  const withUsage = history.runs.filter((run) => (run.usage?.total_tokens ?? 0) > 0);
  const latest = withUsage.at(-1);
  const baseline = withUsage.slice(0, baselineCount);
  const recent = withUsage.slice(-recentCount);
  const baselineAverageTotalTokens = average(baseline.map((run) => run.usage?.total_tokens ?? 0));
  const recentAverageTotalTokens = average(recent.map((run) => run.usage?.total_tokens ?? 0));
  const latestTotalTokens = latest?.usage?.total_tokens;

  return {
    latest,
    baselineAverageTotalTokens,
    recentAverageTotalTokens,
    deltaFromBaseline:
      latestTotalTokens !== undefined && baselineAverageTotalTokens !== undefined
        ? latestTotalTokens - baselineAverageTotalTokens
        : undefined,
  };
}

export function getDreamsRunHistoryPath(location: DreamsHistoryLocation): string {
  return path.join(
    location.basePath,
    location.engramRoot,
    location.workingPath,
    'dreams',
    HISTORY_FILE,
  );
}

function parseDreamsRunHistory(raw: string): DreamsRunHistory {
  const parsed = parseJsonRecord(raw);

  return {
    version: HISTORY_VERSION,
    updatedAt:
      typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    runs: Array.isArray(parsed.runs)
      ? parsed.runs.filter((run): run is DreamsRunRecord => isDreamsRunRecord(run))
      : [],
  };
}

function createEmptyHistory(): DreamsRunHistory {
  return {
    version: HISTORY_VERSION,
    updatedAt: new Date().toISOString(),
    runs: [],
  };
}

function parseJsonRecord(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  return isRecord(parsed) ? parsed : {};
}

function average(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }

  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function isDreamsRunRecord(value: unknown): value is DreamsRunRecord {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.timestamp === 'string' &&
    typeof value.provider === 'string' &&
    typeof value.model === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
