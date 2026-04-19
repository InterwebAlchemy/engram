import { ItemView, Menu, type WorkspaceLeaf, setIcon } from 'obsidian';
import type EngramPlugin from '../main';
import {
  DEFAULT_ENGRAM_TAB,
  ENGRAM_VIEW_TYPE,
  type EngramTabId,
} from '../constants';
import type { EngramTab } from './tab';
import { ChatTab } from './chat';
import { DreamsTab } from './dreams';
import { MemoriesTab } from './memory';
import { SnapshotsTab } from './snapshots';

const ENGRAM_VIEW_TITLE = 'Engram';
const ENGRAM_VIEW_ICON = 'brain-circuit';
const MENU_MODE_MAX_WIDTH = 200;
const ICONS_ONLY_MAX_WIDTH = 360;

type TabStripMode = 'full' | 'icons' | 'menu';

export class EngramView extends ItemView {
  private readonly tabs: Map<EngramTabId, EngramTab>;
  private readonly viewType = ENGRAM_VIEW_TYPE;
  private readonly displayText = ENGRAM_VIEW_TITLE;
  private readonly iconName = ENGRAM_VIEW_ICON;
  private tabStripEl!: HTMLElement;
  private tabBodyEl!: HTMLElement;
  private activeId: EngramTabId = DEFAULT_ENGRAM_TAB;
  private resizeObserver: ResizeObserver | null = null;
  private tabStripMode: TabStripMode = 'full';

  constructor(leaf: WorkspaceLeaf, plugin: EngramPlugin) {
    super(leaf);
    this.tabs = new Map<EngramTabId, EngramTab>([
      ['chat', new ChatTab(this.app, plugin)],
      ['dreams', new DreamsTab(plugin)],
      ['memories', new MemoriesTab(this.app, plugin)],
      ['snapshots', new SnapshotsTab(this.app, plugin)],
    ]);
  }

  getViewType(): string {
    return this.viewType;
  }

  getDisplayText(): string {
    return this.displayText;
  }

  getIcon(): string {
    return this.iconName;
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children.item(1);
    if (!(container instanceof HTMLElement)) {
      throw new Error('Engram view container was not available.');
    }
    container.empty();
    container.addClass('engram-view-container');

    this.tabStripEl = container.createDiv({ cls: 'engram-tab-strip' });
    this.tabBodyEl = container.createDiv({ cls: 'engram-tab-body' });

    this.startObservingTabWidth(container);
    this.updateTabStripMode(container.clientWidth);
    this.renderTabStrip();
    await this.activateTab(this.activeId);
  }

  async onClose(): Promise<void> {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    await Promise.all(
      Array.from(this.tabs.values(), async (tab) => {
        await Promise.resolve(tab.unmount());
      }),
    );
  }

  /** Switch to the given tab, unmounting whatever was active. */
  async activateTab(id: EngramTabId): Promise<void> {
    const next = this.tabs.get(id);
    if (next === undefined) {
      return;
    }
    const current = this.tabs.get(this.activeId);
    if (current !== undefined && this.activeId !== id) {
      await Promise.resolve(current.unmount());
    }
    this.activeId = id;
    this.renderTabStrip();
    this.tabBodyEl.empty();
    await Promise.resolve(next.mount(this.tabBodyEl));
  }

  /** Refresh a specific tab (mounted or not). No-op if tab has no refresh. */
  async refreshTab(id: EngramTabId): Promise<void> {
    const tab = this.tabs.get(id);
    if (tab?.refresh === undefined) {
      return;
    }
    await Promise.resolve(tab.refresh());
  }

  /** Access a tab instance by id for calls that need a specific type. */
  getTab(id: EngramTabId): EngramTab | undefined {
    return this.tabs.get(id);
  }

  private renderTabStrip(): void {
    this.tabStripEl.empty();
    this.tabStripEl.toggleClass('is-icons-only', this.tabStripMode === 'icons');
    this.tabStripEl.toggleClass('is-menu', this.tabStripMode === 'menu');
    if (this.tabStripMode === 'menu') {
      this.renderTabMenuButton();
      return;
    }
    for (const [id, tab] of this.tabs) {
      const btn = this.tabStripEl.createEl('button', {
        cls: `engram-tab-btn${id === this.activeId ? ' is-active' : ''}`,
        attr: {
          'aria-label': tab.label,
          'data-tab-id': id,
          title: tab.label,
        },
      });
      const iconEl = btn.createSpan({ cls: 'engram-tab-icon' });
      setIcon(iconEl, tab.icon);
      btn.createSpan({ cls: 'engram-tab-label', text: tab.label });
      btn.addEventListener('click', () => {
        void this.activateTab(id);
      });
    }
  }

  private renderTabMenuButton(): void {
    const activeTab = this.tabs.get(this.activeId);
    if (activeTab === undefined) {
      return;
    }

    const btn = this.tabStripEl.createEl('button', {
      cls: 'engram-tab-menu-btn',
      attr: {
        'aria-label': `Switch Engram tab. Current tab: ${activeTab.label}`,
        title: `Current tab: ${activeTab.label}`,
      },
    });
    const activeIcon = btn.createSpan({ cls: 'engram-tab-icon' });
    setIcon(activeIcon, activeTab.icon);
    const menuIcon = btn.createSpan({ cls: 'engram-tab-menu-icon' });
    setIcon(menuIcon, 'menu');
    btn.addEventListener('click', (event: MouseEvent) => {
      this.openTabMenu(event);
    });
  }

  private openTabMenu(event: MouseEvent): void {
    const menu = new Menu();
    for (const [id, tab] of this.tabs) {
      menu.addItem((item) => {
        item
          .setTitle(id === this.activeId ? `${tab.label} ✓` : tab.label)
          .setIcon(tab.icon)
          .onClick(() => {
            void this.activateTab(id);
          });
      });
    }
    menu.showAtMouseEvent(event);
  }

  private startObservingTabWidth(container: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries.at(0);
      const width = entry?.contentRect.width ?? container.clientWidth;
      this.updateTabStripMode(width);
    });
    this.resizeObserver.observe(container);
  }

  private updateTabStripMode(width: number): void {
    const nextMode = width <= MENU_MODE_MAX_WIDTH
      ? 'menu'
      : width <= ICONS_ONLY_MAX_WIDTH
        ? 'icons'
        : 'full';
    if (nextMode === this.tabStripMode) {
      return;
    }
    this.tabStripMode = nextMode;
    this.renderTabStrip();
  }
}
