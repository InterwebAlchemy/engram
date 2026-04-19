import { type App, setIcon } from 'obsidian';
import {
  MemoryState,
  MemoryType,
  type VaultNote,
} from '@interwebalchemy/engram-core';
import type { MemoryMode } from './memory';

const PREVIEW_LENGTH = 120;
const RELATED_TAG_LIMIT = 4;
const MEMORY_STATE_BY_VALUE: Record<string, MemoryState> = {
  [MemoryState.Core]: MemoryState.Core,
  [MemoryState.Remembered]: MemoryState.Remembered,
  [MemoryState.Default]: MemoryState.Default,
  [MemoryState.Forgotten]: MemoryState.Forgotten,
};
const MEMORY_TYPE_BY_VALUE: Record<string, MemoryType> = {
  [MemoryType.Fact]: MemoryType.Fact,
  [MemoryType.Entity]: MemoryType.Entity,
  [MemoryType.Reflection]: MemoryType.Reflection,
};

export const MEMORY_MODE_LABELS: Record<MemoryMode, string> = {
  overview: 'Overview',
  explore: 'Explore',
  edit: 'Edit',
};
export const MEMORY_MODE_ORDER = ['overview', 'explore', 'edit'] as const;
export const MEMORY_STATE_ORDER = [
  MemoryState.Core,
  MemoryState.Remembered,
  MemoryState.Default,
  MemoryState.Forgotten,
] as const;
export const MEMORY_TYPE_OPTIONS = [
  MemoryType.Fact,
  MemoryType.Entity,
  MemoryType.Reflection,
] as const;
export const MEMORY_STATE_OPTIONS = [
  MemoryState.Core,
  MemoryState.Remembered,
  MemoryState.Default,
  MemoryState.Forgotten,
] as const;

interface RenderLibraryControlsOptions {
  description: string;
  filterState: MemoryState | undefined;
  filterType: MemoryType | undefined;
  onQueryChange: (value: string) => void;
  onRefresh: () => void;
  onStateChange: (value: MemoryState | undefined) => void;
  onTypeChange: (value: MemoryType | undefined) => void;
  parent: HTMLElement;
  query: string;
}

interface RenderExploreBoardOptions {
  app: App;
  notes: VaultNote[];
  parent: HTMLElement;
  relationshipCounts: Map<string, number>;
}

interface RenderEditableNotesOptions {
  app: App;
  notes: VaultNote[];
  onStateChange: (path: string, nextValue: string) => void;
  parent: HTMLElement;
  updatingPaths: Set<string>;
}

export function renderLibraryControls(options: RenderLibraryControlsOptions): void {
  const {
    description,
    filterState,
    filterType,
    onQueryChange,
    onRefresh,
    onStateChange,
    onTypeChange,
    parent,
    query,
  } = options;
  const bar = parent.createDiv({ cls: 'engram-memory-filters' });

  const queryInput = bar.createEl('input', {
    cls: 'engram-memory-search',
    attr: {
      placeholder: 'Search title, tags, thread, or content…',
      type: 'search',
    },
  });
  queryInput.value = query;
  queryInput.addEventListener('input', () => {
    onQueryChange(queryInput.value);
  });

  const typeSelect = bar.createEl('select', { cls: 'engram-filter-select' });
  typeSelect.createEl('option', { value: '', text: 'All types' });
  for (const type of MEMORY_TYPE_OPTIONS) {
    typeSelect.createEl('option', { value: type, text: capitalize(type) });
  }
  typeSelect.value = filterType ?? '';
  typeSelect.addEventListener('change', () => {
    onTypeChange(parseMemoryType(typeSelect.value));
  });

  const stateSelect = bar.createEl('select', { cls: 'engram-filter-select' });
  stateSelect.createEl('option', { value: '', text: 'All states' });
  for (const state of MEMORY_STATE_OPTIONS) {
    stateSelect.createEl('option', { value: state, text: capitalize(state) });
  }
  stateSelect.value = filterState ?? '';
  stateSelect.addEventListener('change', () => {
    onStateChange(parseMemoryState(stateSelect.value));
  });

  const refreshBtn = bar.createEl('button', {
    cls: 'engram-toolbar-btn',
    attr: { 'aria-label': 'Refresh memory data' },
  });
  setIcon(refreshBtn, 'refresh-cw');
  refreshBtn.addEventListener('click', onRefresh);

  parent.createDiv({
    cls: 'engram-memory-helper-copy',
    text: description,
  });
}

export function renderExploreBoard(options: RenderExploreBoardOptions): void {
  const {
    app,
    notes,
    parent,
    relationshipCounts,
  } = options;
  const board = parent.createDiv({ cls: 'engram-memory-explorer-board' });
  for (const state of MEMORY_STATE_ORDER) {
    const notesInState = notes
      .filter((note) => resolveMemoryState(note) === state)
      .sort((left, right) => {
        const leftKey = relationshipCounts.get(left.path) ?? 0;
        const rightKey = relationshipCounts.get(right.path) ?? 0;
        return rightKey - leftKey;
      });
    if (notesInState.length === 0) {
      continue;
    }

    const column = board.createDiv({ cls: `engram-memory-explorer-column engram-memory-${state}` });
    const header = column.createDiv({ cls: 'engram-memory-explorer-column-header' });
    header.createSpan({
      cls: 'engram-memory-explorer-column-title',
      text: capitalize(state),
    });
    header.createSpan({
      cls: 'engram-memory-explorer-column-count',
      text: `${String(notesInState.length)} memories`,
    });

    const cards = column.createDiv({ cls: 'engram-memory-explorer-cards' });
    for (const note of notesInState) {
      renderExplorerCard(app, cards, note, relationshipCounts.get(note.path) ?? 0);
    }
  }
}

export function renderEditableNotes(options: RenderEditableNotesOptions): void {
  const {
    app,
    notes,
    onStateChange,
    parent,
    updatingPaths,
  } = options;
  if (notes.length === 0) {
    parent.createDiv({
      cls: 'engram-empty',
      text: 'No memories match the current filters.',
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
    const group = parent.createDiv({ cls: 'engram-memory-group' });
    group.createEl('h4', {
      cls: 'engram-group-header',
      text: `${capitalize(type)} (${String(groupNotes.length)})`,
    });
    for (const note of groupNotes) {
      renderEditableNote({
        app,
        note,
        onStateChange,
        parent: group,
        updatingPaths,
      });
    }
  }
}

export function parseMemoryType(value: string): MemoryType | undefined {
  return MEMORY_TYPE_BY_VALUE[value];
}

export function parseMemoryState(value: string): MemoryState | undefined {
  return MEMORY_STATE_BY_VALUE[value];
}

export function buildRelationshipCounts(notes: VaultNote[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const note of notes) {
    const tags = new Set(readTags(note));
    const thread = readFrontmatterString(note.frontmatter.thread);
    let count = 0;
    for (const other of notes) {
      if (other.path === note.path) {
        continue;
      }
      const sameThread = thread.length > 0 && thread === readFrontmatterString(other.frontmatter.thread);
      const sharedTag = readTags(other).some((tag) => tags.has(tag));
      if (sameThread || sharedTag) {
        count += 1;
      }
    }
    counts.set(note.path, count);
  }
  return counts;
}

export function resolveMemoryTypeLabel(note: VaultNote): string {
  return typeof note.frontmatter.type === 'string'
    ? note.frontmatter.type
    : 'unknown';
}

export function normalizeMemoryType(value: unknown): MemoryType | undefined {
  switch (value) {
    case MemoryType.Fact:
    case MemoryType.Entity:
    case MemoryType.Reflection:
      return value;
    default:
      return undefined;
  }
}

export function resolveMemoryState(note: VaultNote): MemoryState {
  const {
    frontmatter: { memory_state: state },
  } = note;
  return typeof state === 'string'
    ? parseMemoryState(state) ?? MemoryState.Default
    : MemoryState.Default;
}

export function readTags(note: VaultNote): string[] {
  const {
    frontmatter: { tags },
  } = note;
  return Array.isArray(tags)
    ? tags.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0)
    : [];
}

export function readFrontmatterString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function baseName(notePath: string): string {
  return (notePath.split('/').pop() ?? notePath).replace(/\.md$/u, '');
}

export function buildPreview(content: string): string {
  const suffix = content.length > PREVIEW_LENGTH ? '...' : '';
  return `${content.slice(0, PREVIEW_LENGTH)}${suffix}`;
}

export function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0].toUpperCase()}${value.slice(1)}`;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function renderExplorerCard(app: App, parent: HTMLElement, note: VaultNote, relatedCount: number): void {
  const card = parent.createDiv({ cls: 'engram-memory-node' });
  const fileName = baseName(note.path);

  const header = card.createDiv({ cls: 'engram-memory-node-header' });
  const button = header.createEl('button', {
    cls: 'engram-memory-node-title',
    text: fileName,
  });
  button.addEventListener('click', () => {
    void app.workspace.openLinkText(note.path, '', false);
  });
  header.createSpan({
    cls: 'engram-memory-node-type',
    text: capitalize(resolveMemoryTypeLabel(note)),
  });

  const meta = card.createDiv({ cls: 'engram-memory-node-meta' });
  const thread = readFrontmatterString(note.frontmatter.thread);
  if (thread.length > 0) {
    meta.createSpan({ cls: 'engram-memory-node-chip', text: `Thread ${thread}` });
  }
  meta.createSpan({
    cls: 'engram-memory-node-chip',
    text: `${String(relatedCount)} related`,
  });

  const tags = readTags(note);
  if (tags.length > 0) {
    const tagRow = card.createDiv({ cls: 'engram-memory-tags' });
    for (const tag of tags.slice(0, RELATED_TAG_LIMIT)) {
      tagRow.createSpan({ cls: 'engram-tag', text: `#${tag}` });
    }
  }

  card.createDiv({
    cls: 'engram-memory-preview',
    text: buildPreview(note.content),
  });
}

function renderEditableNote(options: {
  app: App;
  note: VaultNote;
  onStateChange: (path: string, nextValue: string) => void;
  parent: HTMLElement;
  updatingPaths: Set<string>;
}): void {
  const {
    app,
    note,
    onStateChange,
    parent,
    updatingPaths,
  } = options;
  const item = parent.createDiv({ cls: 'engram-memory-item' });
  const header = item.createDiv({ cls: 'engram-memory-item-header' });
  const fileName = baseName(note.path);

  const nameEl = header.createSpan({
    cls: 'engram-memory-name',
    text: fileName,
  });
  nameEl.addEventListener('click', () => {
    void app.workspace.openLinkText(note.path, '', false);
  });

  const stateControls = header.createDiv({ cls: 'engram-memory-state-controls' });
  stateControls.createSpan({
    cls: 'engram-memory-state-label',
    text: 'State',
  });

  const state = resolveMemoryState(note);
  const stateSelect = stateControls.createEl('select', {
    cls: 'engram-memory-state-select',
    attr: { 'aria-label': `Memory state for ${fileName}` },
  });
  for (const option of MEMORY_STATE_OPTIONS) {
    stateSelect.createEl('option', {
      value: option,
      text: capitalize(option),
    });
  }
  stateSelect.value = state;
  stateSelect.disabled = updatingPaths.has(note.path);
  stateSelect.addEventListener('change', () => {
    onStateChange(note.path, stateSelect.value);
  });

  const tags = readTags(note);
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
