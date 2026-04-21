import * as path from 'node:path';
import { type App, setIcon } from 'obsidian';
import { type MemoryState, VaultNote } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import type { EngramTabId } from '../constants';
import type { EngramTab } from './tab';
import { DreamsTab } from './dreams';
import {
  MEMORY_MODE_LABELS,
  MEMORY_MODE_ORDER,
  baseName,
  getErrorMessage,
  normalizeMemoryType,
  parseMemoryState,
  pathToConnectionRef,
  readConnectionRefs,
  readFrontmatterString,
  readTags,
  renderLibraryControls,
  resolveMemoryState,
  resolveMemoryTypeLabel,
} from './memory-view-helpers';
import { renderExploreGraph } from './memory-graph';

const MEMORY_TAB_TITLE = 'Memory';
const MEMORY_TAB_ICON = 'database';

export type MemoryMode = 'overview' | 'explore';

export class MemoriesTab implements EngramTab {
  readonly id: EngramTabId = 'memories';
  readonly label = MEMORY_TAB_TITLE;
  readonly icon = MEMORY_TAB_ICON;

  private readonly app: App;
  private readonly dreamsTab: DreamsTab;
  private readonly plugin: EngramPlugin;
  private readonly updatingPaths = new Set<string>();
  private activeMode: MemoryMode = 'overview';
  private bodyEl: HTMLElement | null = null;
  private error: string | null = null;
  private filterState: MemoryState | undefined;
  private filterType: string | undefined;
  private modeStripEl: HTMLElement | null = null;
  private notes: VaultNote[] = [];
  private parent: HTMLElement | null = null;
  private disposeExploreGraph: (() => void) | null = null;
  private selectedExplorePath: string | null = null;
  private includeArchived = false;
  private query = '';

  constructor(app: App, plugin: EngramPlugin) {
    this.app = app;
    this.plugin = plugin;
    this.dreamsTab = new DreamsTab(plugin);
  }

  mount(parent: HTMLElement): void {
    parent.empty();
    parent.addClass('engram-memory-container');
    this.parent = parent;

    this.renderToolbar(parent);
    this.modeStripEl = parent.createDiv({ cls: 'engram-memory-mode-strip' });
    this.bodyEl = parent.createDiv({ cls: 'engram-memory-pane' });
    this.renderModeStrip();
    void this.renderCurrentMode({ forceReload: true });
  }

  unmount(): void {
    this.clearExploreGraph();
    this.dreamsTab.unmount();
    if (this.parent !== null) {
      this.parent.empty();
      this.parent.removeClass('engram-memory-container');
      this.parent = null;
    }
    this.bodyEl = null;
    this.modeStripEl = null;
  }

  async refresh(): Promise<void> {
    if (this.activeMode === 'overview') {
      await this.dreamsTab.refresh();
      return;
    }
    await this.renderCurrentMode({ forceReload: true });
  }

  showExplore(): void {
    void this.switchMode('explore');
  }

  showOverview(): void {
    void this.switchMode('overview');
  }

  private renderToolbar(parent: HTMLElement): void {
    const toolbar = parent.createDiv({ cls: 'engram-toolbar' });
    const copy = toolbar.createDiv({ cls: 'engram-toolbar-copy' });
    copy.createEl('h3', { text: MEMORY_TAB_TITLE });
    copy.createEl('p', {
      cls: 'setting-item-description',
      text: 'Explore the full Engram graph with inline node editing and connection controls.',
    });

    const actions = toolbar.createDiv({ cls: 'engram-toolbar-actions' });
    const refreshBtn = actions.createEl('button', {
      cls: 'engram-toolbar-btn',
      attr: { 'aria-label': 'Refresh memory view' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => {
      void this.refresh();
    });
  }

  private renderModeStrip(): void {
    if (this.modeStripEl === null) {
      return;
    }
    this.modeStripEl.empty();
    for (const mode of MEMORY_MODE_ORDER) {
      const button = this.modeStripEl.createEl('button', {
        cls: `engram-memory-mode-btn${mode === this.activeMode ? ' is-active' : ''}`,
        text: MEMORY_MODE_LABELS[mode],
      });
      button.addEventListener('click', () => {
        void this.switchMode(mode);
      });
    }
  }

  private async switchMode(mode: MemoryMode): Promise<void> {
    if (mode === this.activeMode && this.bodyEl?.children.length !== 0) {
      return;
    }

    if (this.activeMode === 'overview') {
      this.dreamsTab.unmount();
    }
    this.activeMode = mode;
    this.renderModeStrip();
    await this.renderCurrentMode({ forceReload: mode !== 'overview' });
  }

  private async renderCurrentMode(options: { forceReload: boolean }): Promise<void> {
    if (this.bodyEl === null) {
      return;
    }
    this.clearExploreGraph();
    this.bodyEl.empty();

    if (this.activeMode === 'overview') {
      this.bodyEl.addClass('engram-memory-pane-overview');
      this.bodyEl.removeClass('engram-memory-pane-library');
      this.dreamsTab.mount(this.bodyEl);
      return;
    }

    this.bodyEl.removeClass('engram-memory-pane-overview');
    this.bodyEl.addClass('engram-memory-pane-library');
    if (options.forceReload) {
      await this.loadNotes();
    }

    if (this.error !== null) {
      this.bodyEl.createDiv({
        cls: 'engram-empty',
        text: `Could not load Engram graph: ${this.error}`,
      });
      return;
    }

    this.renderExploreMode();
  }

  private async loadNotes(): Promise<void> {
    try {
      const engramRootPath = path.resolve(this.plugin.getVaultBasePath(), this.plugin.settings.engramRoot);
      const notePaths = await this.plugin.fileAdapter.list(engramRootPath);
      const loaded = await Promise.all(
        notePaths.map(async (notePath) => await VaultNote.read(this.plugin.fileAdapter, notePath).catch(() => null)),
      );
      this.notes = loaded
        .filter((note): note is VaultNote => note !== null)
        .map((note) => normalizeExplorerNote(note, engramRootPath))
        .sort((left, right) => left.path.localeCompare(right.path));
      this.error = null;
    } catch (error) {
      this.notes = [];
      this.error = getErrorMessage(error);
    }
  }

  private renderExploreMode(): void {
    if (this.bodyEl === null) {
      return;
    }
    renderLibraryControls({
      parent: this.bodyEl,
      filterState: this.filterState,
      filterType: this.filterType,
      includeArchived: this.includeArchived,
      onIncludeArchivedToggle: (value) => {
        this.includeArchived = value;
        this.renderFilteredCurrentMode();
      },
      onQueryChange: (value) => {
        this.query = value;
        this.renderFilteredCurrentMode();
      },
      onRefresh: () => {
        void this.renderCurrentMode({ forceReload: true });
      },
      onStateChange: (value) => {
        this.filterState = value;
        this.renderFilteredCurrentMode();
      },
      onTypeChange: (value) => {
        this.filterType = value;
        this.renderFilteredCurrentMode();
      },
      query: this.query,
      description: 'Explore all Engram notes as an interactive graph. Click a node to edit state/tags in the side drawer, drag between handles to connect, and click manual edges to disconnect.',
    });
    const visibleNotes = this.getVisibleNotes();
    if (visibleNotes.length === 0) {
      this.bodyEl.createDiv({
        cls: 'engram-empty',
        text: 'No Engram notes match the current filters.',
      });
      return;
    }

    const stillVisible = visibleNotes.some((note) => note.path === this.selectedExplorePath);
    if (!stillVisible) {
      this.selectedExplorePath = null;
    }

    this.disposeExploreGraph = renderExploreGraph({
      initialSelectedPath: this.selectedExplorePath,
      notes: visibleNotes,
      onConnect: async (sourcePath, targetPath) => {
        await this.updateManualConnection(sourcePath, targetPath, true);
      },
      onDisconnect: async (sourcePath, targetPath) => {
        await this.updateManualConnection(sourcePath, targetPath, false);
      },
      onOpenNote: (path) => {
        void this.app.workspace.openLinkText(toVaultPath(path, this.plugin.getVaultBasePath()), '', false);
      },
      onSelectedPathChange: (path) => {
        this.selectedExplorePath = path;
      },
      onStateChange: async (path, nextValue) => {
        await this.updateMemoryState(path, nextValue);
      },
      onTagsChange: async (path, nextTags) => {
        await this.updateMemoryTags(path, nextTags);
      },
      parent: this.bodyEl,
      updatingPaths: this.updatingPaths,
    });
  }

  private renderFilteredCurrentMode(): void {
    if (this.activeMode === 'overview') {
      return;
    }
    void this.renderCurrentMode({ forceReload: false });
  }

  private getVisibleNotes(): VaultNote[] {
    const query = this.query.trim().toLowerCase();
    return this.notes.filter((note) => {
      const noteType = normalizeMemoryType(note.frontmatter.type);
      if (!this.includeArchived && this.filterType !== 'archive' && noteType === 'archive') {
        return false;
      }
      if (this.filterState !== undefined && resolveMemoryState(note) !== this.filterState) {
        return false;
      }
      if (this.filterType !== undefined && noteType !== this.filterType) {
        return false;
      }
      if (query.length === 0) {
        return true;
      }

      return [
        baseName(note.path),
        note.content,
        ...readTags(note),
        readFrontmatterString(note.frontmatter.thread),
        resolveMemoryTypeLabel(note),
      ]
        .join(' ')
        .toLowerCase()
        .includes(query);
    });
  }

  private async updateMemoryState(path: string, nextValue: string): Promise<void> {
    const nextState = parseMemoryState(nextValue);
    if (nextState === undefined) {
      return;
    }

    this.updatingPaths.add(path);
    try {
      await this.plugin.memoryManager.update(path, undefined, {
        memory_state: nextState,
      });
      const updated = this.notes.find((note) => note.path === path);
      if (updated !== undefined) {
        updated.frontmatter.memory_state = nextState;
      }
    } finally {
      this.updatingPaths.delete(path);
    }

    this.renderFilteredCurrentMode();
  }

  private async updateMemoryTags(path: string, nextTags: string[]): Promise<void> {
    const normalizedTags = normalizeTagList(nextTags);
    this.updatingPaths.add(path);
    try {
      await this.plugin.memoryManager.update(path, undefined, {
        tags: normalizedTags,
      });
      const updated = this.notes.find((note) => note.path === path);
      if (updated !== undefined) {
        updated.frontmatter.tags = normalizedTags;
      }
    } finally {
      this.updatingPaths.delete(path);
    }

    this.renderFilteredCurrentMode();
  }

  private async updateManualConnection(
    sourcePath: string,
    targetPath: string,
    shouldConnect: boolean,
  ): Promise<void> {
    if (sourcePath === targetPath) {
      return;
    }

    const source = this.notes.find((note) => note.path === sourcePath);
    const target = this.notes.find((note) => note.path === targetPath);
    if (source === undefined || target === undefined) {
      return;
    }

    const sourceRef = pathToConnectionRef(sourcePath);
    const targetRef = pathToConnectionRef(targetPath);

    const sourceConnections = new Set(readConnectionRefs(source));
    const targetConnections = new Set(readConnectionRefs(target));

    if (shouldConnect) {
      sourceConnections.add(targetRef);
      targetConnections.add(sourceRef);
    } else {
      sourceConnections.delete(targetRef);
      targetConnections.delete(sourceRef);
    }

    this.updatingPaths.add(sourcePath);
    this.updatingPaths.add(targetPath);
    try {
      const nextSourceConnections = Array.from(sourceConnections).sort((left, right) => left.localeCompare(right));
      const nextTargetConnections = Array.from(targetConnections).sort((left, right) => left.localeCompare(right));
      await this.plugin.memoryManager.update(sourcePath, undefined, {
        connections: nextSourceConnections,
      });
      await this.plugin.memoryManager.update(targetPath, undefined, {
        connections: nextTargetConnections,
      });
      source.frontmatter.connections = nextSourceConnections;
      target.frontmatter.connections = nextTargetConnections;
    } finally {
      this.updatingPaths.delete(sourcePath);
      this.updatingPaths.delete(targetPath);
    }

    this.renderFilteredCurrentMode();
  }

  private clearExploreGraph(): void {
    this.disposeExploreGraph?.();
    this.disposeExploreGraph = null;
  }
}

function normalizeTagList(tags: string[]): string[] {
  const unique = new Set<string>();
  for (const tag of tags) {
    const normalized = normalizeTag(tag);
    if (normalized.length > 0) {
      unique.add(normalized);
    }
  }
  return Array.from(unique).sort((left, right) => left.localeCompare(right));
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#+/u, '').toLowerCase();
}

function normalizeExplorerNote(note: VaultNote, engramRootPath: string): VaultNote {
  const inferredType = inferExplorerType(note.path, engramRootPath);
  const frontmatter = { ...note.frontmatter };
  const currentType = readFrontmatterString(frontmatter.type).toLowerCase();

  if (inferredType !== 'memory' && (currentType.length === 0 || currentType === 'fact')) {
    frontmatter.type = inferredType;
  }

  if (inferredType === 'thread') {
    const threadId = readFrontmatterString(frontmatter.thread_id);
    const existingThread = readFrontmatterString(frontmatter.thread);
    if (threadId.length > 0 && existingThread.length === 0) {
      frontmatter.thread = threadId;
    }
  }

  return new VaultNote(note.path, frontmatter, note.content);
}

function inferExplorerType(notePath: string, engramRootPath: string): string {
  const relativePath = toPosix(path.relative(engramRootPath, notePath));
  if (relativePath.startsWith('memory/')) {
    return 'memory';
  }
  if (relativePath.startsWith('threads/')) {
    return 'thread';
  }
  if (relativePath.startsWith('skills/')) {
    return 'skill';
  }
  if (relativePath.startsWith('notes/')) {
    return 'note';
  }
  if (relativePath.startsWith('inbox/')) {
    return 'inbox';
  }
  if (relativePath.startsWith('conversations/')) {
    return 'conversation';
  }
  if (relativePath.startsWith('working/')) {
    return 'working';
  }
  if (relativePath.startsWith('archive/')) {
    return 'archive';
  }
  return 'unknown';
}

function toPosix(value: string): string {
  return value.replace(/\\/gu, '/');
}

function toVaultPath(notePath: string, vaultBasePath: string): string {
  const normalizedNotePath = toPosix(path.resolve(notePath));
  const normalizedVaultPath = toPosix(path.resolve(vaultBasePath));
  if (normalizedNotePath.startsWith(`${normalizedVaultPath}/`)) {
    return normalizedNotePath.slice(normalizedVaultPath.length + 1);
  }
  return notePath;
}
