import { type App, setIcon } from 'obsidian';
import type EngramPlugin from '../main';
import type { EngramTabId } from '../constants';
import type { EngramTab } from './tab';
import { SnapshotManager } from '../../../snapshot/src/manager';
import type { SnapshotRecord } from '../../../snapshot/src/types';
import {
  renderSnapshotsSection,
  showNotice,
  showSnapshotRestoreConfirm,
} from './dreams-view-helpers';

const SNAPSHOTS_TAB_TITLE = 'Snapshots';
const SNAPSHOTS_TAB_ICON = 'camera';

export class SnapshotsTab implements EngramTab {
  readonly id: EngramTabId = 'snapshots';
  readonly label = SNAPSHOTS_TAB_TITLE;
  readonly icon = SNAPSHOTS_TAB_ICON;

  private readonly app: App;
  private readonly plugin: EngramPlugin;
  private parent: HTMLElement | null = null;
  private snapshots: SnapshotRecord[] = [];
  private loading = false;
  private error: string | null = null;

  constructor(app: App, plugin: EngramPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  mount(parent: HTMLElement): void {
    parent.empty();
    parent.addClass('engram-snapshots-container');
    this.parent = parent;
    void this.refresh();
  }

  unmount(): void {
    if (this.parent !== null) {
      this.parent.empty();
      this.parent.removeClass('engram-snapshots-container');
      this.parent = null;
    }
  }

  async refresh(): Promise<void> {
    if (this.parent === null) {
      return;
    }
    this.loading = true;
    this.error = null;
    this.render();
    try {
      this.snapshots = await SnapshotsTab.createSnapshotManager().list();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    if (this.parent === null) {
      return;
    }
    this.parent.empty();

    const toolbar = this.parent.createDiv({ cls: 'engram-dreams-toolbar' });
    const copy = toolbar.createDiv({ cls: 'engram-dreams-toolbar-copy' });
    copy.createEl('h3', { text: 'Snapshots' });
    copy.createEl('p', {
      cls: 'setting-item-description',
      text: 'Snapshots capture the full Engram state so you can roll back a Dream run or an experimental cleanup.',
    });

    const actions = toolbar.createDiv({ cls: 'engram-dreams-toolbar-actions' });
    const refreshBtn = actions.createEl('button', {
      cls: 'engram-toolbar-btn',
      attr: { 'aria-label': 'Refresh snapshots' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => { void this.refresh(); });

    const createBtn = actions.createEl('button', {
      cls: 'mod-cta',
      text: 'Create snapshot',
    });
    createBtn.addEventListener('click', () => { void this.handleCreateSnapshot(); });

    if (this.loading) {
      this.parent.createDiv({
        cls: 'engram-dreams-empty',
        text: 'Loading snapshots...',
      });
      return;
    }
    if (this.error !== null) {
      this.parent.createDiv({
        cls: 'engram-dreams-empty',
        text: `Could not load snapshots: ${this.error}`,
      });
      return;
    }

    renderSnapshotsSection(
      this.parent,
      this.snapshots,
      SnapshotsTab.getSnapshotsDir(),
      this.handleRestoreSnapshot.bind(this),
    );
  }

  private async handleCreateSnapshot(): Promise<void> {
    try {
      const snapshot = await SnapshotsTab.createSnapshotManager().create({
        vaultPath: this.plugin.getVaultBasePath(),
        engramRoot: this.plugin.settings.engramRoot,
        label: 'Manual snapshot from Snapshots tab',
        reason: 'obsidian-snapshots-ui',
      });
      showNotice(`Snapshot created: ${snapshot.id}`);
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice(`Snapshot failed: ${message}`);
    }
  }

  private handleRestoreSnapshot(snapshot: SnapshotRecord): void {
    showSnapshotRestoreConfirm(this.app, snapshot.id, () => {
      void this.restoreSnapshot(snapshot);
    });
  }

  private async restoreSnapshot(snapshot: SnapshotRecord): Promise<void> {
    try {
      const result = await SnapshotsTab.createSnapshotManager().restore({
        snapshotIdOrPath: snapshot.id,
        vaultPath: this.plugin.getVaultBasePath(),
        engramRoot: this.plugin.settings.engramRoot,
        label: `Pre-restore safety snapshot for ${snapshot.id}`,
        reason: 'obsidian-snapshots-ui-restore',
      });
      showNotice(
        result.safetySnapshot === undefined
          ? `Restored ${snapshot.id}`
          : `Restored ${snapshot.id}. Safety snapshot: ${result.safetySnapshot.id}`,
      );
      this.plugin.refreshEngramView('chat');
      this.plugin.refreshEngramView('memories');
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showNotice(`Restore failed: ${message}`);
    }
  }

  private static createSnapshotManager(): SnapshotManager {
    return new SnapshotManager();
  }

  private static getSnapshotsDir(): string {
    return SnapshotsTab.createSnapshotManager().getSnapshotsDir();
  }
}
