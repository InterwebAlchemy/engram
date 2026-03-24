import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
import { MemoryState, MemoryType } from '@interwebalchemy/engram-core';
import type { VaultNote } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import { MEMORY_VIEW_TYPE } from '../constants';

interface MemoryGroup {
  type: string;
  notes: VaultNote[];
}

export class EngramMemoryView extends ItemView {
  private plugin: EngramPlugin;
  private listContainer!: HTMLElement;
  private filterState: MemoryState | undefined;
  private filterType: MemoryType | undefined;

  constructor(leaf: WorkspaceLeaf, plugin: EngramPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return MEMORY_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Engram Memories';
  }

  getIcon(): string {
    return 'database';
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('engram-memory-container');

    this.renderFilters(container);
    this.listContainer = container.createDiv({ cls: 'engram-memory-list' });
    await this.refresh();
  }

  async onClose(): Promise<void> {
    // Nothing to clean up
  }

  // ─── Filters ──────────────────────────────────────────────────────────

  private renderFilters(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: 'engram-memory-filters' });

    // Type filter
    const typeSelect = bar.createEl('select', { cls: 'engram-filter-select' });
    typeSelect.createEl('option', { value: '', text: 'All types' });
    for (const t of [MemoryType.Fact, MemoryType.Entity, MemoryType.Reflection]) {
      typeSelect.createEl('option', { value: t, text: t });
    }
    typeSelect.addEventListener('change', async () => {
      this.filterType = typeSelect.value ? (typeSelect.value as MemoryType) : undefined;
      await this.refresh();
    });

    // State filter
    const stateSelect = bar.createEl('select', { cls: 'engram-filter-select' });
    stateSelect.createEl('option', { value: '', text: 'All states' });
    for (const s of [MemoryState.Core, MemoryState.Remembered, MemoryState.Default, MemoryState.Forgotten]) {
      stateSelect.createEl('option', { value: s, text: s });
    }
    stateSelect.addEventListener('change', async () => {
      this.filterState = stateSelect.value ? (stateSelect.value as MemoryState) : undefined;
      await this.refresh();
    });

    // Refresh button
    const refreshBtn = bar.createEl('button', {
      cls: 'engram-toolbar-btn',
      attr: { 'aria-label': 'Refresh' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.refresh());
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    this.listContainer.empty();

    let notes: VaultNote[];
    try {
      notes = await this.plugin.memoryManager.list({
        type: this.filterType,
        state: this.filterState,
      });
    } catch (err) {
      this.listContainer.createDiv({
        cls: 'engram-empty',
        text: `Could not load memories: ${(err as Error).message}`,
      });
      return;
    }

    if (notes.length === 0) {
      this.listContainer.createDiv({
        cls: 'engram-empty',
        text: 'No memories found.',
      });
      return;
    }

    // Group by type
    const groups = new Map<string, VaultNote[]>();
    for (const note of notes) {
      const type = String(note.frontmatter.type ?? 'unknown');
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type)!.push(note);
    }

    for (const [type, groupNotes] of groups) {
      this.renderGroup(type, groupNotes);
    }
  }

  private renderGroup(type: string, notes: VaultNote[]): void {
    const group = this.listContainer.createDiv({ cls: 'engram-memory-group' });
    group.createEl('h4', { text: `${type} (${notes.length})`, cls: 'engram-group-header' });

    for (const note of notes) {
      this.renderMemoryItem(group, note);
    }
  }

  private renderMemoryItem(parent: HTMLElement, note: VaultNote): void {
    const item = parent.createDiv({ cls: 'engram-memory-item' });

    const header = item.createDiv({ cls: 'engram-memory-item-header' });

    // File name
    const fileName = note.path.split('/').pop() ?? note.path;
    const nameEl = header.createSpan({
      cls: 'engram-memory-name',
      text: fileName.replace(/\.md$/, ''),
    });
    // Click to open in editor
    nameEl.addEventListener('click', () => {
      this.app.workspace.openLinkText(note.path, '', false);
    });

    // State badge (clickable to cycle)
    const state = (note.frontmatter.memory_state as MemoryState) ?? MemoryState.Default;
    const badge = header.createSpan({
      cls: `engram-memory-badge engram-memory-${state}`,
      text: state,
    });
    badge.addEventListener('click', async () => {
      const states = [
        MemoryState.Default,
        MemoryState.Core,
        MemoryState.Remembered,
        MemoryState.Forgotten,
      ];
      const idx = states.indexOf(state);
      const next = states[(idx + 1) % states.length];
      await this.plugin.memoryManager.update(note.path, undefined, {
        memory_state: next,
      });
      await this.refresh();
    });

    // Tags
    const tags = (note.frontmatter.tags as string[] | undefined) ?? [];
    if (tags.length > 0) {
      const tagRow = item.createDiv({ cls: 'engram-memory-tags' });
      for (const tag of tags) {
        tagRow.createSpan({ cls: 'engram-tag', text: `#${tag}` });
      }
    }

    // Preview
    item.createDiv({
      cls: 'engram-memory-preview',
      text: note.content.slice(0, 120) + (note.content.length > 120 ? '...' : ''),
    });
  }
}
