import * as fs from 'node:fs';
import * as path from 'node:path';
import { env } from 'node:process';

const DEFAULT_CONFIG_DIR = '.engram';
const DEFAULT_CONFIG_FILE = 'config.json';
const DEFAULT_SNAPSHOTS_DIR = 'snapshots';

function homeDir(): string {
  return env.HOME ?? '';
}

function getCliConfigPath(): string {
  return path.join(homeDir(), DEFAULT_CONFIG_DIR, DEFAULT_CONFIG_FILE);
}

function expandHome(value: string): string {
  return value.startsWith('~') ? path.join(homeDir(), value.slice(1)) : value;
}

function readConfiguredSnapshotsDir(): string | null {
  try {
    const raw = fs.readFileSync(getCliConfigPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const { snapshotDir } = parsed as { snapshotDir?: unknown };
    return typeof snapshotDir === 'string' && snapshotDir.trim().length > 0
      ? expandHome(snapshotDir.trim())
      : null;
  } catch {
    return null;
  }
}

export function resolveSnapshotsDir(configuredDir?: string): string {
  if (typeof configuredDir === 'string' && configuredDir.length > 0) {
    return path.resolve(expandHome(configuredDir));
  }

  if (typeof env.ENGRAM_SNAPSHOTS_DIR === 'string' && env.ENGRAM_SNAPSHOTS_DIR.length > 0) {
    return path.resolve(expandHome(env.ENGRAM_SNAPSHOTS_DIR));
  }

  const configDir = readConfiguredSnapshotsDir();
  if (configDir !== null) {
    return path.resolve(configDir);
  }

  return path.resolve(path.join(homeDir(), DEFAULT_CONFIG_DIR, DEFAULT_SNAPSHOTS_DIR));
}
