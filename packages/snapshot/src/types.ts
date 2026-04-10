export type SnapshotFormat = 'directory' | 'tar.gz';

export interface SnapshotRecord {
  id: string;
  createdAt: string;
  format: SnapshotFormat;
  snapshotPath: string;
  vaultPath?: string;
  engramRoot: string;
  label?: string;
  reason?: string;
  sizeBytes?: number;
  source: 'managed' | 'legacy';
}

export interface SnapshotManifest {
  version: 1;
  id: string;
  createdAt: string;
  format: 'directory';
  snapshotPath: string;
  vaultPath: string;
  engramRoot: string;
  label?: string;
  reason?: string;
}

export interface SnapshotManagerOptions {
  snapshotsDir?: string;
}

export interface CreateSnapshotOptions {
  vaultPath: string;
  engramRoot?: string;
  label?: string;
  reason?: string;
}

export interface RestoreSnapshotOptions {
  snapshotIdOrPath: string;
  vaultPath: string;
  engramRoot?: string;
  createSafetySnapshot?: boolean;
  preserveRelativePaths?: string[];
  label?: string;
  reason?: string;
}

export interface RestoreSnapshotResult {
  restored: SnapshotRecord;
  safetySnapshot?: SnapshotRecord;
  preservedRelativePaths?: string[];
}
