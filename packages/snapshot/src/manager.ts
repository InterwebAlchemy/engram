import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type {
  CreateSnapshotOptions,
  RestoreSnapshotOptions,
  RestoreSnapshotResult,
  SnapshotManifest,
  SnapshotManagerOptions,
  SnapshotRecord,
} from './types';

const execFileAsync = promisify(execFile);
const MANIFEST_FILE = 'manifest.json';

export class SnapshotManager {
  private readonly snapshotsDir: string;

  constructor(options: SnapshotManagerOptions = {}) {
    this.snapshotsDir = path.resolve(options.snapshotsDir ?? path.join(process.cwd(), '.snapshots'));
  }

  getSnapshotsDir(): string {
    return this.snapshotsDir;
  }

  async create(options: CreateSnapshotOptions): Promise<SnapshotRecord> {
    const vaultPath = path.resolve(options.vaultPath);
    const engramRoot = options.engramRoot ?? 'engram';
    const engramPath = path.join(vaultPath, engramRoot);

    await assertDirectoryExists(engramPath, `Engram root not found at ${engramPath}`);
    await fs.mkdir(this.snapshotsDir, { recursive: true });

    const id = buildSnapshotId();
    const snapshotDir = path.join(this.snapshotsDir, id);
    const snapshotEngramPath = path.join(snapshotDir, engramRoot);

    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.cp(engramPath, snapshotEngramPath, { recursive: true });

    const manifest: SnapshotManifest = {
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      format: 'directory',
      snapshotPath: snapshotDir,
      vaultPath,
      engramRoot,
      label: options.label,
      reason: options.reason,
    };

    await fs.writeFile(
      path.join(snapshotDir, MANIFEST_FILE),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    return {
      id: manifest.id,
      createdAt: manifest.createdAt,
      format: manifest.format,
      snapshotPath: manifest.snapshotPath,
      vaultPath: manifest.vaultPath,
      engramRoot: manifest.engramRoot,
      label: manifest.label,
      reason: manifest.reason,
      sizeBytes: await getDirectorySize(snapshotDir),
      source: 'managed',
    };
  }

  async list(): Promise<SnapshotRecord[]> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    const entries = await fs.readdir(this.snapshotsDir, { withFileTypes: true });
    const records = await Promise.all(
      entries.map(async (entry) => {
        if (entry.isDirectory()) {
          return this.readManagedSnapshot(path.join(this.snapshotsDir, entry.name));
        }
        if (entry.isFile() && entry.name.endsWith('.tar.gz')) {
          return this.readLegacyArchive(path.join(this.snapshotsDir, entry.name));
        }
        return null;
      }),
    );

    return records
      .filter((record): record is SnapshotRecord => record !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async restore(options: RestoreSnapshotOptions): Promise<RestoreSnapshotResult> {
    const vaultPath = path.resolve(options.vaultPath);
    const requestedEngramRoot = options.engramRoot ?? 'engram';
    const target = await this.resolveSnapshot(options.snapshotIdOrPath);
    const engramRoot = target.engramRoot || requestedEngramRoot;
    const engramPath = path.join(vaultPath, engramRoot);

    await fs.mkdir(vaultPath, { recursive: true });

    let safetySnapshot: SnapshotRecord | undefined;
    if (options.createSafetySnapshot !== false && await pathExists(engramPath)) {
      safetySnapshot = await this.create({
        vaultPath,
        engramRoot,
        label: options.label ?? `Pre-restore safety snapshot for ${target.id}`,
        reason: options.reason ?? 'pre-restore',
      });
    }

    await fs.rm(engramPath, { recursive: true, force: true });

    if (target.format === 'directory') {
      await fs.cp(path.join(target.snapshotPath, engramRoot), engramPath, { recursive: true });
    } else {
      await execFileAsync('tar', ['-xzf', target.snapshotPath, '-C', vaultPath]);
    }

    return {
      restored: target,
      safetySnapshot,
    };
  }

  private async resolveSnapshot(snapshotIdOrPath: string): Promise<SnapshotRecord> {
    const directPath = path.resolve(snapshotIdOrPath);

    if (await pathExists(directPath)) {
      const stat = await fs.stat(directPath);
      if (stat.isDirectory()) {
        const record = await this.readManagedSnapshot(directPath);
        if (record) return record;
      }
      if (stat.isFile() && directPath.endsWith('.tar.gz')) {
        const record = await this.readLegacyArchive(directPath);
        if (record) return record;
      }
    }

    const withinSnapshotsDir = path.join(this.snapshotsDir, snapshotIdOrPath);
    if (await pathExists(withinSnapshotsDir)) {
      const stat = await fs.stat(withinSnapshotsDir);
      if (stat.isDirectory()) {
        const record = await this.readManagedSnapshot(withinSnapshotsDir);
        if (record) return record;
      }
      if (stat.isFile() && withinSnapshotsDir.endsWith('.tar.gz')) {
        const record = await this.readLegacyArchive(withinSnapshotsDir);
        if (record) return record;
      }
    }

    const candidates = await this.list();
    const matched = candidates.find((record) => record.id === snapshotIdOrPath);
    if (!matched) {
      throw new Error(`Snapshot not found: ${snapshotIdOrPath}`);
    }

    return matched;
  }

  private async readManagedSnapshot(snapshotDir: string): Promise<SnapshotRecord | null> {
    const manifestPath = path.join(snapshotDir, MANIFEST_FILE);
    if (!(await pathExists(manifestPath))) return null;

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as SnapshotManifest;

    return {
      id: manifest.id,
      createdAt: manifest.createdAt,
      format: manifest.format,
      snapshotPath: manifest.snapshotPath,
      vaultPath: manifest.vaultPath,
      engramRoot: manifest.engramRoot,
      label: manifest.label,
      reason: manifest.reason,
      sizeBytes: await getDirectorySize(snapshotDir),
      source: 'managed',
    };
  }

  private async readLegacyArchive(archivePath: string): Promise<SnapshotRecord | null> {
    const stat = await fs.stat(archivePath);
    const fileName = path.basename(archivePath);
    const id = fileName.replace(/\.tar\.gz$/, '');

    return {
      id,
      createdAt: inferCreatedAtFromId(id) ?? stat.mtime.toISOString(),
      format: 'tar.gz',
      snapshotPath: archivePath,
      engramRoot: 'engram',
      sizeBytes: stat.size,
      source: 'legacy',
    };
  }
}

function buildSnapshotId(): string {
  return `engram-${new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z')}`;
}

function inferCreatedAtFromId(id: string): string | null {
  const match = id.match(/^engram-(\d{4}-\d{2}-\d{2})T(\d{6})/);
  if (!match) return null;

  const [, date, time] = match;
  const iso = `${date}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
  return new Date(iso).toISOString();
}

async function assertDirectoryExists(dirPath: string, errorMessage: string): Promise<void> {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) throw new Error(errorMessage);
  } catch {
    throw new Error(errorMessage);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function getDirectorySize(dirPath: string): Promise<number> {
  const stat = await fs.stat(dirPath);
  if (stat.isFile()) return stat.size;

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(dirPath, entry.name);
      return getDirectorySize(entryPath);
    }),
  );

  return sizes.reduce((sum, size) => sum + size, 0);
}
