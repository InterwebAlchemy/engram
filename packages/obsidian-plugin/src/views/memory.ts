import { type App, setIcon } from 'obsidian';
import type { MemoryState, MemoryType, VaultNote } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import type { EngramTabId } from '../constants';
import type { EngramTab } from './tab';
import { DreamsTab } from './dreams';
import {
  MEMORY_MODE_LABELS,
  MEMORY_MODE_ORDER,
  baseName,
  buildRelationshipCounts,
  getErrorMessage,
  normalizeMemoryType,
  parseMemoryState,
  readFrontmatterString,
  readTags,
  renderEditableNotes,
  renderExploreBoard,
  renderLibraryControls,
  resolveMemoryState,
  resolveMemoryTypeLabel,
} from './memory-view-helpers';

const MEMORY_TAB_TITLE = 'Memory';
const MEMORY_TAB_ICON = 'database';

export type MemoryMode = 'overview' | 'explore' | 'edit';

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
  private filterType: MemoryType | undefined;
  private modeStripEl: HTMLElement | null = null;
  private notes: VaultNote[] = [];
  private parent: HTMLElement | null = null;
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

  showEdit(): void {
    void this.switchMode('edit');
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
      text: 'See memory pressure, explore relationships across the vault, and edit note state from one place.',
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
        text: `Could not load memories: ${this.error}`,
      });
      return;
    }

    if (this.activeMode === 'explore') {
      this.renderExploreMode();
      return;
    }

    this.renderEditMode();
  }

  private async loadNotes(): Promise<void> {
    try {
      this.notes = await this.plugin.memoryManager.list();
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
      description: 'Move through the memory map by state. Cards surface thread and tag relationships so nearby memories are easier to follow.',
    });
    const visibleNotes = this.getVisibleNotes();
    if (visibleNotes.length === 0) {
      this.bodyEl.createDiv({
        cls: 'engram-empty',
        text: 'No memories match the current filters.',
      });
      return;
    }

    renderExploreBoard({
      app: this.app,
      notes: visibleNotes,
      parent: this.bodyEl,
      relationshipCounts: buildRelationshipCounts(visibleNotes),
    });
  }

  private renderEditMode(): void {
    if (this.bodyEl === null) {
      return;
    }
    renderLibraryControls({
      parent: this.bodyEl,
      filterState: this.filterState,
      filterType: this.filterType,
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
      description: 'Filter the library, inspect note contents, and update memory state directly without accidental click-cycling.',
    });

    const list = this.bodyEl.createDiv({ cls: 'engram-memory-list' });
    renderEditableNotes({
      app: this.app,
      notes: this.getVisibleNotes(),
      onStateChange: (path, nextValue) => {
        void this.updateMemoryState(path, nextValue);
      },
      parent: list,
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
      if (this.filterState !== undefined && resolveMemoryState(note) !== this.filterState) {
        return false;
      }
      if (this.filterType !== undefined && normalizeMemoryType(note.frontmatter.type) !== this.filterType) {
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
}
