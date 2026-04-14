import * as fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  CreateSnapshotOptions,
  RestoreSnapshotOptions,
  RestoreSnapshotResult,
  SnapshotManifest,
  SnapshotManagerOptions,
  SnapshotRecord,
} from './types';

const MANIFEST_FILE = 'manifest.json';
const DEFAULT_ENGRAM_ROOT = 'engram';
const MANIFEST_VERSION = 1;
const JSON_INDENT = 2;
const SNAPSHOT_ARCHIVE_EXTENSION = '.tar.gz';
const TAR_EXTRACT_ARGS = ['-xzf', '-C'] as const;
const TIMESTAMP_REPLACEMENT_PATTERN = /[:.]/gv;
const SNAPSHOT_ID_PATTERN =
  /^engram-(?<date>\d{4}-\d{2}-\d{2})T(?<hour>\d{2})(?<minute>\d{2})(?<second>\d{2})/v;
const LEADING_PATH_SEPARATOR_PATTERN = /^(?:[\/\\])+/v;
const extractArchiveAsync = promisify((
  snapshotPath: string,
  vaultPath: string,
  callback: (error: Error | null) => void,
): void => {
  execFile(
    'tar',
    [TAR_EXTRACT_ARGS[0], snapshotPath, TAR_EXTRACT_ARGS[1], vaultPath],
    (error) => {
      callback(error);
    },
  );
});

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
    const engramRoot = options.engramRoot ?? DEFAULT_ENGRAM_ROOT;
    const engramPath = path.join(vaultPath, engramRoot);

    await assertDirectoryExists(engramPath, `Engram root not found at ${engramPath}`);
    await fs.mkdir(this.snapshotsDir, { recursive: true });

    const id = buildSnapshotId();
    const snapshotDir = path.join(this.snapshotsDir, id);
    const snapshotEngramPath = path.join(snapshotDir, engramRoot);

    await fs.mkdir(snapshotDir, { recursive: true });
    await fs.cp(engramPath, snapshotEngramPath, { recursive: true });

    const manifest = createSnapshotManifest(snapshotDir, {
      id,
      vaultPath,
      engramRoot,
      label: options.label,
      reason: options.reason,
    });
    await writeSnapshotManifest(snapshotDir, manifest);

    return buildManagedSnapshotRecord(manifest, await getDirectorySize(snapshotDir));
  }

  async list(): Promise<SnapshotRecord[]> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    const entries = await fs.readdir(this.snapshotsDir, { withFileTypes: true });
    const records = await Promise.all(
      entries.map(async (entry) => await readSnapshotEntry(this.snapshotsDir, entry.name, entry)),
    );

    return records
      .filter((record): record is SnapshotRecord => record !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async restore(options: RestoreSnapshotOptions): Promise<RestoreSnapshotResult> {
    const vaultPath = path.resolve(options.vaultPath);
    const requestedEngramRoot = options.engramRoot ?? DEFAULT_ENGRAM_ROOT;
    const target = await this.resolveSnapshot(options.snapshotIdOrPath);
    const engramRoot = selectEngramRoot(target.engramRoot, requestedEngramRoot);
    const engramPath = path.join(vaultPath, engramRoot);
    const preserveRelativePaths = dedupePreservePaths(options.preserveRelativePaths ?? []);

    await fs.mkdir(vaultPath, { recursive: true });

    const safetySnapshot = await this.createSafetySnapshotIfNeeded({
      createSafetySnapshot: options.createSafetySnapshot,
      engramPath,
      vaultPath,
      engramRoot,
      label: options.label,
      reason: options.reason,
      targetId: target.id,
    });
    const preserveStagingDir = await createPreserveStagingDir(this.snapshotsDir, preserveRelativePaths);
    const preservedRelativePaths = await stagePreservedPaths(
      preserveStagingDir,
      preserveRelativePaths,
      engramPath,
    );

    try {
      await replaceEngramWithSnapshot(target, engramRoot, engramPath, vaultPath);
      await restorePreservedPaths(preserveStagingDir, preservedRelativePaths, engramPath);
      return { restored: target, safetySnapshot, preservedRelativePaths };
    } finally {
      await cleanupDirectory(preserveStagingDir);
    }
  }

  private async createSafetySnapshotIfNeeded(options: {
    createSafetySnapshot?: boolean;
    engramPath: string;
    vaultPath: string;
    engramRoot: string;
    label?: string;
    reason?: string;
    targetId: string;
  }): Promise<SnapshotRecord | undefined> {
    if (options.createSafetySnapshot === false || !(await pathExists(options.engramPath))) {
      return undefined;
    }

    return await this.create({
      vaultPath: options.vaultPath,
      engramRoot: options.engramRoot,
      label: options.label ?? `Pre-restore safety snapshot for ${options.targetId}`,
      reason: options.reason ?? 'pre-restore',
    });
  }

  private async resolveSnapshot(snapshotIdOrPath: string): Promise<SnapshotRecord> {
    const directPath = path.resolve(snapshotIdOrPath);
    const directRecord = await tryReadSnapshotRecord(directPath);
    if (directRecord !== null) {
      return directRecord;
    }

    const withinSnapshotsDir = path.join(this.snapshotsDir, snapshotIdOrPath);
    const nestedRecord = await tryReadSnapshotRecord(withinSnapshotsDir);
    if (nestedRecord !== null) {
      return nestedRecord;
    }

    const candidates = await this.list();
    const matched = candidates.find((record) => record.id === snapshotIdOrPath);
    if (matched === undefined) {
      throw new Error(`Snapshot not found: ${snapshotIdOrPath}`);
    }

    return matched;
  }
}

function createSnapshotManifest(
  snapshotDir: string,
  options: {
    id: string;
    vaultPath: string;
    engramRoot: string;
    label?: string;
    reason?: string;
  },
): SnapshotManifest {
  return {
    version: MANIFEST_VERSION,
    id: options.id,
    createdAt: new Date().toISOString(),
    format: 'directory',
    snapshotPath: snapshotDir,
    vaultPath: options.vaultPath,
    engramRoot: options.engramRoot,
    label: options.label,
    reason: options.reason,
  };
}

async function writeSnapshotManifest(snapshotDir: string, manifest: SnapshotManifest): Promise<void> {
  await fs.writeFile(
    path.join(snapshotDir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, JSON_INDENT)}\n`,
    'utf8',
  );
}

function buildManagedSnapshotRecord(
  manifest: SnapshotManifest,
  sizeBytes: number,
): SnapshotRecord {
  return {
    id: manifest.id,
    createdAt: manifest.createdAt,
    format: manifest.format,
    snapshotPath: manifest.snapshotPath,
    vaultPath: manifest.vaultPath,
    engramRoot: manifest.engramRoot,
    label: manifest.label,
    reason: manifest.reason,
    sizeBytes,
    source: 'managed',
  };
}

function selectEngramRoot(
  snapshotEngramRoot: string | undefined,
  requestedEngramRoot: string,
): string {
  return typeof snapshotEngramRoot === 'string' && snapshotEngramRoot.length > 0
    ? snapshotEngramRoot
    : requestedEngramRoot;
}

async function createPreserveStagingDir(
  snapshotsDir: string,
  preserveRelativePaths: string[],
): Promise<string | null> {
  return preserveRelativePaths.length === 0
    ? null
    : await fs.mkdtemp(path.join(snapshotsDir, '.restore-preserve-'));
}

async function stagePreservedPaths(
  preserveStagingDir: string | null,
  preserveRelativePaths: string[],
  engramPath: string,
): Promise<string[]> {
  if (preserveStagingDir === null) {
    return [];
  }

  const staged = await Promise.all(
    preserveRelativePaths.map(async (relativePath) => {
      const sourcePath = path.join(engramPath, relativePath);
      if (!(await pathExists(sourcePath))) {
        return null;
      }

      await copyPath(sourcePath, path.join(preserveStagingDir, relativePath));
      return relativePath;
    }),
  );

  return staged.filter((relativePath): relativePath is string => relativePath !== null);
}

async function restorePreservedPaths(
  preserveStagingDir: string | null,
  preservedRelativePaths: string[],
  engramPath: string,
): Promise<void> {
  if (preserveStagingDir === null || preservedRelativePaths.length === 0) {
    return;
  }

  await Promise.all(
    preservedRelativePaths.map(async (relativePath) => {
      await copyPath(
        path.join(preserveStagingDir, relativePath),
        path.join(engramPath, relativePath),
      );
    }),
  );
}

async function replaceEngramWithSnapshot(
  target: SnapshotRecord,
  engramRoot: string,
  engramPath: string,
  vaultPath: string,
): Promise<void> {
  await fs.rm(engramPath, { recursive: true, force: true });

  if (target.format === 'directory') {
    await fs.cp(path.join(target.snapshotPath, engramRoot), engramPath, { recursive: true });
    return;
  }

  await extractArchive(target.snapshotPath, vaultPath);
}

async function extractArchive(snapshotPath: string, vaultPath: string): Promise<void> {
  await extractArchiveAsync(snapshotPath, vaultPath);
}

async function tryReadSnapshotRecord(candidatePath: string): Promise<SnapshotRecord | null> {
  if (!(await pathExists(candidatePath))) {
    return null;
  }

  const stat = await fs.stat(candidatePath);
  if (stat.isDirectory()) {
    return await readManagedSnapshot(candidatePath);
  }
  if (stat.isFile() && candidatePath.endsWith(SNAPSHOT_ARCHIVE_EXTENSION)) {
    return await readLegacyArchive(candidatePath);
  }

  return null;
}

async function readSnapshotEntry(
  snapshotsDir: string,
  entryName: string,
  entry: Dirent,
): Promise<SnapshotRecord | null> {
  if (entry.isDirectory()) {
    return await readManagedSnapshot(path.join(snapshotsDir, entryName));
  }
  if (entry.isFile() && entryName.endsWith(SNAPSHOT_ARCHIVE_EXTENSION)) {
    return await readLegacyArchive(path.join(snapshotsDir, entryName));
  }

  return null;
}

async function readManagedSnapshot(snapshotDir: string): Promise<SnapshotRecord | null> {
  const manifestPath = path.join(snapshotDir, MANIFEST_FILE);
  if (!(await pathExists(manifestPath))) {
    return null;
  }

  const raw = await fs.readFile(manifestPath, 'utf8');
  const manifest = parseSnapshotManifest(raw);
  return buildManagedSnapshotRecord(manifest, await getDirectorySize(snapshotDir));
}

async function readLegacyArchive(archivePath: string): Promise<SnapshotRecord | null> {
  const stat = await fs.stat(archivePath);
  const id = path.basename(archivePath).replace(/\.tar\.gz$/v, '');

  return {
    id,
    createdAt: inferCreatedAtFromId(id) ?? stat.mtime.toISOString(),
    format: 'tar.gz',
    snapshotPath: archivePath,
    engramRoot: DEFAULT_ENGRAM_ROOT,
    sizeBytes: stat.size,
    source: 'legacy',
  };
}

function parseSnapshotManifest(raw: string): SnapshotManifest {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) {
    throw new Error('Invalid snapshot manifest: expected an object.');
  }

  assertManifestCore(parsed.version, parsed.id, parsed.createdAt, parsed.format);
  assertManifestPaths(parsed.snapshotPath, parsed.vaultPath, parsed.engramRoot);
  assertManifestMetadata(parsed.label, parsed.reason);

  return {
    version: MANIFEST_VERSION,
    id: requireString(parsed.id),
    createdAt: requireString(parsed.createdAt),
    format: 'directory',
    snapshotPath: requireString(parsed.snapshotPath),
    vaultPath: requireString(parsed.vaultPath),
    engramRoot: requireString(parsed.engramRoot),
    label: optionalString(parsed.label),
    reason: optionalString(parsed.reason),
  };
}

function buildSnapshotId(): string {
  return `engram-${new Date().toISOString().replace(TIMESTAMP_REPLACEMENT_PATTERN, '').replace('Z', 'Z')}`;
}

function inferCreatedAtFromId(id: string): string | null {
  const groups = SNAPSHOT_ID_PATTERN.exec(id)?.groups;
  if (groups === undefined) {
    return null;
  }

  const { date, hour, minute, second } = groups;
  return new Date(`${date}T${hour}:${minute}:${second}Z`).toISOString();
}

async function assertDirectoryExists(dirPath: string, errorMessage: string): Promise<void> {
  try {
    const stat = await fs.stat(dirPath);
    if (!stat.isDirectory()) {
      throw new Error(errorMessage);
    }
  } catch (error) {
    throw error instanceof Error ? new Error(errorMessage, { cause: error }) : new Error(errorMessage);
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

function dedupePreservePaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePreserveRelativePath))];
}

function normalizePreserveRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(LEADING_PATH_SEPARATOR_PATTERN, '');
  if (normalized.length === 0 || normalized === '.' || normalized.startsWith('..')) {
    throw new Error(`Invalid preserve path: ${relativePath}`);
  }

  return normalized;
}

async function copyPath(sourcePath: string, targetPath: string): Promise<void> {
  const stat = await fs.stat(sourcePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (stat.isDirectory()) {
    await fs.cp(sourcePath, targetPath, { recursive: true, force: true });
    return;
  }

  await fs.copyFile(sourcePath, targetPath);
}

async function cleanupDirectory(dirPath: string | null): Promise<void> {
  if (dirPath === null) {
    return;
  }

  await fs.rm(dirPath, { recursive: true, force: true }).catch(() => undefined);
}

async function getDirectorySize(dirPath: string): Promise<number> {
  const stat = await fs.stat(dirPath);
  if (stat.isFile()) {
    return stat.size;
  }

  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const sizes = await Promise.all(
    entries.map(async (entry) => await getDirectorySize(path.join(dirPath, entry.name))),
  );

  return sizes.reduce((sum, size) => sum + size, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function assertManifestCore(
  version: unknown,
  id: unknown,
  createdAt: unknown,
  format: unknown,
): asserts version is 1 {
  if (version !== MANIFEST_VERSION) {
    throw new Error('Invalid snapshot manifest: unsupported version.');
  }
  if (typeof id !== 'string' || typeof createdAt !== 'string' || format !== 'directory') {
    throw new Error('Invalid snapshot manifest: malformed core fields.');
  }
}

function assertManifestPaths(
  snapshotPath: unknown,
  vaultPath: unknown,
  engramRoot: unknown,
): void {
  if (
    typeof snapshotPath !== 'string' ||
    typeof vaultPath !== 'string' ||
    typeof engramRoot !== 'string'
  ) {
    throw new Error('Invalid snapshot manifest: malformed path fields.');
  }
}

function assertManifestMetadata(label: unknown, reason: unknown): void {
  if (
    (label !== undefined && typeof label !== 'string') ||
    (reason !== undefined && typeof reason !== 'string')
  ) {
    throw new Error('Invalid snapshot manifest: malformed metadata.');
  }
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected string value in snapshot manifest.');
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error('Expected string or undefined in snapshot manifest.');
  }
  return value;
}
