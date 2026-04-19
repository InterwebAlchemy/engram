import { type App, setIcon } from 'obsidian';
import { MemoryState, MemoryType } from '@interwebalchemy/engram-core';
import type { VaultNote } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import type { EngramTabId } from '../constants';
import type { EngramTab } from './tab';

const MEMORIES_TAB_TITLE = 'Memories';
const MEMORIES_TAB_ICON = 'database';
const PREVIEW_LENGTH = 120;
const STATE_CYCLE = [
  MemoryState.Default,
  MemoryState.Core,
  MemoryState.Remembered,
  MemoryState.Forgotten,
];
const MEMORY_TYPE_OPTIONS = [
  MemoryType.Fact,
  MemoryType.Entity,
  MemoryType.Reflection,
];
const MEMORY_STATE_OPTIONS = [
  MemoryState.Core,
  MemoryState.Remembered,
  MemoryState.Default,
  MemoryState.Forgotten,
];

export class MemoriesTab implements EngramTab {
  readonly id: EngramTabId = 'memories';
  readonly label = MEMORIES_TAB_TITLE;
  readonly icon = MEMORIES_TAB_ICON;

  private readonly app: App;
  private readonly plugin: EngramPlugin;
  private parent: HTMLElement | null = null;
  private listContainer: HTMLElement | null = null;
  private filterState: MemoryState | undefined;
  private filterType: MemoryType | undefined;

  constructor(app: App, plugin: EngramPlugin) {
    this.app = app;
    this.plugin = plugin;
  }

  mount(parent: HTMLElement): void {
    parent.empty();
    parent.addClass('engram-memory-container');
    this.parent = parent;
    this.renderFilters(parent);
    this.listContainer = parent.createDiv({ cls: 'engram-memory-list' });
    void this.refresh();
  }

  unmount(): void {
    if (this.parent !== null) {
      this.parent.empty();
      this.parent.removeClass('engram-memory-container');
      this.parent = null;
      this.listContainer = null;
    }
  }

  private renderFilters(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: 'engram-memory-filters' });

    const typeSelect = bar.createEl('select', { cls: 'engram-filter-select' });
    typeSelect.createEl('option', { value: '', text: 'All types' });
    for (const type of MEMORY_TYPE_OPTIONS) {
      typeSelect.createEl('option', { value: type, text: type });
    }
    typeSelect.addEventListener('change', () => {
      this.filterType = parseMemoryType(typeSelect.value);
      void this.refresh();
    });

    const stateSelect = bar.createEl('select', { cls: 'engram-filter-select' });
    stateSelect.createEl('option', { value: '', text: 'All states' });
    for (const state of MEMORY_STATE_OPTIONS) {
      stateSelect.createEl('option', { value: state, text: state });
    }
    stateSelect.addEventListener('change', () => {
      this.filterState = parseMemoryState(stateSelect.value);
      void this.refresh();
    });

    const refreshBtn = bar.createEl('button', {
      cls: 'engram-toolbar-btn',
      attr: { 'aria-label': 'Refresh' },
    });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => {
      void this.refresh();
    });
  }

  async refresh(): Promise<void> {
    if (this.listContainer === null) {
      return;
    }
    this.listContainer.empty();

    try {
      const notes = await this.plugin.memoryManager.list({
        type: this.filterType,
        state: this.filterState,
      });
      this.renderNotes(notes);
    } catch (err) {
      this.listContainer.createDiv({
        cls: 'engram-empty',
        text: `Could not load memories: ${getErrorMessage(err)}`,
      });
    }
  }

  private renderNotes(notes: VaultNote[]): void {
    if (this.listContainer === null) {
      return;
    }
    if (notes.length === 0) {
      this.listContainer.createDiv({
        cls: 'engram-empty',
        text: 'No memories found.',
      });
      return;
    }

    const groups = new Map<string, VaultNote[]>();
    for (const note of notes) {
      const type = resolveMemoryTypeLabel(note);
      const groupNotes = groups.get(type);
      if (groupNotes === undefined) {
        groups.set(type, [note]);
      } else {
        groupNotes.push(note);
      }
    }

    for (const [type, groupNotes] of groups) {
      this.renderGroup(type, groupNotes);
    }
  }

  private renderGroup(type: string, notes: VaultNote[]): void {
    if (this.listContainer === null) {
      return;
    }
    const group = this.listContainer.createDiv({ cls: 'engram-memory-group' });
    group.createEl('h4', { text: `${type} (${notes.length})`, cls: 'engram-group-header' });

    for (const note of notes) {
      this.renderMemoryItem(group, note);
    }
  }

  private renderMemoryItem(parent: HTMLElement, note: VaultNote): void {
    const item = parent.createDiv({ cls: 'engram-memory-item' });

    const header = item.createDiv({ cls: 'engram-memory-item-header' });

    const fileName = note.path.split('/').pop() ?? note.path;
    const nameEl = header.createSpan({
      cls: 'engram-memory-name',
      text: fileName.replace(/\.md$/u, ''),
    });
    nameEl.addEventListener('click', () => {
      void this.app.workspace.openLinkText(note.path, '', false);
    });

    const state = note.frontmatter.memory_state ?? MemoryState.Default;
    const badge = header.createSpan({
      cls: `engram-memory-badge engram-memory-${state}`,
      text: state,
    });
    badge.addEventListener('click', () => {
      void this.cycleMemoryState(note.path, state);
    });

    const tags = (note.frontmatter.tags) ?? [];
    if (tags.length > 0) {
      const tagRow = item.createDiv({ cls: 'engram-memory-tags' });
      for (const tag of tags) {
        tagRow.createSpan({ cls: 'engram-tag', text: `#${tag}` });
      }
    }

    item.createDiv({
      cls: 'engram-memory-preview',
      text: buildPreview(note.content),
    });
  }

  private async cycleMemoryState(path: string, state: MemoryState): Promise<void> {
    const stateIndex = STATE_CYCLE.indexOf(state);
    const nextState = STATE_CYCLE.at((stateIndex + 1) % STATE_CYCLE.length) ?? MemoryState.Default;
    await this.plugin.memoryManager.update(path, undefined, {
      memory_state: nextState,
    });
    await this.refresh();
  }
}

function parseMemoryType(value: string): MemoryType | undefined {
  switch (value) {
    case 'fact':
      return MemoryType.Fact;
    case 'entity':
      return MemoryType.Entity;
    case 'reflection':
      return MemoryType.Reflection;
    default:
      return undefined;
  }
}

function parseMemoryState(value: string): MemoryState | undefined {
  switch (value) {
    case 'core':
      return MemoryState.Core;
    case 'remembered':
      return MemoryState.Remembered;
    case 'default':
      return MemoryState.Default;
    case 'forgotten':
      return MemoryState.Forgotten;
    default:
      return undefined;
  }
}

function resolveMemoryTypeLabel(note: VaultNote): string {
  return typeof note.frontmatter.type === 'string'
    ? note.frontmatter.type
    : 'unknown';
}

function buildPreview(content: string): string {
  const suffix = content.length > PREVIEW_LENGTH ? '...' : '';
  return `${content.slice(0, PREVIEW_LENGTH)}${suffix}`;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
