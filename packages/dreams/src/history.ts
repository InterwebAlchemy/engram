import * as path from 'path';
import type { FileSystemAdapter } from '@interwebalchemy/engram-core';
import type {
  DreamsRunHistory,
  DreamsRunRecord,
  DreamsUsageTrend,
} from './types';

const HISTORY_FILE = 'token-usage-history.json';

export async function readDreamsRunHistory(
  adapter: FileSystemAdapter,
  basePath: string,
  engramRoot: string,
  workingPath: string,
): Promise<DreamsRunHistory> {
  const filePath = getDreamsRunHistoryPath(basePath, engramRoot, workingPath);

  try {
    const raw = await adapter.read(filePath);
    const parsed = JSON.parse(raw) as Partial<DreamsRunHistory>;
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      runs: Array.isArray(parsed.runs) ? parsed.runs as DreamsRunRecord[] : [],
    };
  } catch {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      runs: [],
    };
  }
}

export async function appendDreamsRunHistory(
  adapter: FileSystemAdapter,
  basePath: string,
  engramRoot: string,
  workingPath: string,
  record: DreamsRunRecord,
): Promise<DreamsRunHistory> {
  const filePath = getDreamsRunHistoryPath(basePath, engramRoot, workingPath);
  const history = await readDreamsRunHistory(adapter, basePath, engramRoot, workingPath);
  const next: DreamsRunHistory = {
    version: 1,
    updatedAt: new Date().toISOString(),
    runs: [...history.runs, record],
  };

  await adapter.mkdir(path.dirname(filePath));
  await adapter.write(filePath, `${JSON.stringify(next, null, 2)}\n`);

  return next;
}

export function summarizeDreamsUsage(
  history: DreamsRunHistory,
  baselineCount = 3,
  recentCount = 3,
): DreamsUsageTrend {
  const withUsage = history.runs.filter((run) => (run.usage?.total_tokens ?? 0) > 0);
  const latest = withUsage.at(-1);
  const baseline = withUsage.slice(0, baselineCount);
  const recent = withUsage.slice(-recentCount);

  const baselineAverageTotalTokens = average(baseline.map((run) => run.usage?.total_tokens ?? 0));
  const recentAverageTotalTokens = average(recent.map((run) => run.usage?.total_tokens ?? 0));

  return {
    latest,
    baselineAverageTotalTokens,
    recentAverageTotalTokens,
    deltaFromBaseline:
      latest && baselineAverageTotalTokens !== undefined
        ? latest.usage!.total_tokens - baselineAverageTotalTokens
        : undefined,
  };
}

export function getDreamsRunHistoryPath(
  basePath: string,
  engramRoot: string,
  workingPath: string,
): string {
  return path.join(basePath, engramRoot, workingPath, 'dreams', HISTORY_FILE);
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
