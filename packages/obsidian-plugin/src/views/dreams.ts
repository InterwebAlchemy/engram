import { ItemView, type WorkspaceLeaf } from 'obsidian';
import { defaultMemoryConfig } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import { DREAMS_VIEW_TYPE } from '../constants';
import { DreamsAnalyzer } from '../../../dreams/src/analyzer';
import {
  appendDreamsRunHistory,
  readDreamsRunHistory,
} from '../../../dreams/src/history';
import {
  executeDreamsActions,
  writeDreamStartEntry,
  writeDreamScratchEntry,
} from '../../../dreams/src/runner';
import type {
  DreamsRunHistory,
  DreamsExecutionResult,
  DreamsPlanResult,
  DreamsReport,
} from '../../../dreams/src/types';
import { SnapshotManager } from '../../../snapshot/src/manager';
import type { SnapshotRecord } from '../../../snapshot/src/types';
import { Ciph3rTextAnimator } from '../utils/ciph3r';
import { DreamCanvas } from '../utils/dream-canvas';
import {
  renderDreamResultsSection,
  renderFindingsSections,
  renderSnapshotsSection,
  renderSummarySection,
  renderUsageHistorySection,
  showNotice,
  showSnapshotRestoreConfirm,
} from './dreams-view-helpers';
import {
  renderDreamControls,
  renderDreamToolbar,
} from './dreams-view-controls';
import {
  buildDreamCompletionNotice,
  createDreamPlan,
  createDreamRunRecord,
  findSelectedOption,
  formatLatestDreamLabel,
  getModelOptions,
  runPowerNap,
  syncModelSelection,
  type ModelOption,
} from './dreams-view-support';
const DREAMS_VIEW_TITLE = 'Engram Dreams';
const DREAMS_VIEW_ICON = 'moon-star';
const DREAMING_LABEL = 'Dreaming...';
const POWER_NAP_LABEL = 'Power Napping...';
const DREAMING_ANIMATION_MS = 250;
const NARRATIVE_MAX_TOKENS = 512;
export class EngramDreamsView extends ItemView {
  private readonly plugin: EngramPlugin;
  private readonly viewType = DREAMS_VIEW_TYPE;
  private readonly displayText = DREAMS_VIEW_TITLE;
  private readonly iconName = DREAMS_VIEW_ICON;
  private container!: HTMLElement;
  private report: DreamsReport | null = null;
  private snapshots: SnapshotRecord[] = [];
  private runHistory: DreamsRunHistory | null = null;
  private latestPlan: DreamsPlanResult | null = null;
  private latestExecution: DreamsExecutionResult | null = null;
  private latestRunSnapshot: SnapshotRecord | null = null;
  private loading = false;
  private running = false;
  private error: string | null = null;
  private selectedProviderId = '';
  private selectedModelId = '';
  private dreamCanvas: DreamCanvas | null = null;
  private dreamAnimator: Ciph3rTextAnimator | null = null;
  private overlayLabel = DREAMING_LABEL;
  constructor(leaf: WorkspaceLeaf, plugin: EngramPlugin) {
    super(leaf);
    this.plugin = plugin;
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
      throw new Error('Dreams view container was not available.');
    }
    container.empty();
    container.addClass('engram-dreams-container');
    this.container = container;
    this.syncSelection();
    await this.refresh();
  }
  async onClose(): Promise<void> {
    this.cleanupDreamOverlay();
    await Promise.resolve();
  }
  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();
    try {
      const analyzer = new DreamsAnalyzer(this.plugin.memoryManager);
      const snapshotManager = EngramDreamsView.createSnapshotManager();
      const basePath = this.plugin.getVaultBasePath();
      const [report, snapshots, history] = await Promise.all([
        analyzer.analyze(),
        snapshotManager.list(),
        readDreamsRunHistory(
          this.plugin.fileAdapter,
          basePath,
          this.plugin.settings.engramRoot,
          'working',
        ),
      ]);
      this.report = report;
      this.snapshots = snapshots;
      this.runHistory = history;
      this.syncSelection();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }
  private render(): void {
    this.cleanupDreamOverlay();
    this.container.empty();
    if (this.running) {
      this.renderDreamingOverlay();
      return;
    }
    renderDreamToolbar({
      parent: this.container.createDiv({ cls: 'engram-dreams-toolbar' }),
      onRefresh: () => { void this.refresh(); },
      onCreateSnapshot: () => { void this.handleCreateSnapshot(); },
    });
    renderDreamControls({
      parent: this.container,
      options: this.syncSelection(),
      selectedProviderId: this.selectedProviderId,
      selectedModelId: this.selectedModelId,
      onModelChange: (providerId, modelId) => {
        this.selectedProviderId = providerId;
        this.selectedModelId = modelId;
      },
      onDream: () => { void this.handleDream(); },
      onPowerNap: () => { void this.handlePowerNap(); },
    });
    if (this.loading) {
      this.container.createDiv({
        cls: 'engram-dreams-empty',
        text: 'Analyzing vault health and loading snapshots...',
      });
      return;
    }
    if (this.error !== null) {
      this.container.createDiv({
        cls: 'engram-dreams-empty',
        text: `Could not load Dreams dashboard: ${this.error}`,
      });
      return;
    }
    if (this.report === null) {
      this.container.createDiv({
        cls: 'engram-dreams-empty',
        text: 'No Dreams report available yet.',
      });
      return;
    }
    renderSummarySection(this.container, this.report, this.snapshots);
    renderUsageHistorySection(this.container, this.runHistory);
    renderDreamResultsSection({
      parent: this.container,
      latestPlan: this.latestPlan,
      latestExecution: this.latestExecution,
      latestRunSnapshot: this.latestRunSnapshot,
      selectedLabel: formatLatestDreamLabel(
        this.getSelectedOption(),
        this.latestPlan,
        this.latestExecution,
      ),
    });
    renderFindingsSections(this.container, this.report);
    renderSnapshotsSection(
      this.container,
      this.snapshots,
      EngramDreamsView.getSnapshotsDir(),
      this.handleRestoreSnapshot.bind(this),
    );
  }
  private renderDreamingOverlay(): void {
    const overlay = this.container.createDiv({ cls: 'engram-dreams-overlay' });
    const canvas = overlay.createEl('canvas', { cls: 'engram-dreams-overlay-canvas' });
    this.dreamCanvas = new DreamCanvas(canvas);
    this.dreamCanvas.start();
    const center = overlay.createDiv({ cls: 'engram-dreams-overlay-center' });
    const label = center.createSpan({ cls: 'engram-dreams-overlay-text', text: this.overlayLabel });
    this.dreamAnimator = new Ciph3rTextAnimator(label, this.overlayLabel, DREAMING_ANIMATION_MS);
    this.dreamAnimator.start();
  }
  private cleanupDreamOverlay(): void {
    if (this.dreamCanvas !== null) {
      this.dreamCanvas.stop();
      this.dreamCanvas = null;
    }
    if (this.dreamAnimator !== null) {
      this.dreamAnimator.stop();
      this.dreamAnimator = null;
    }
  }
  private async handleDream(): Promise<void> {
    if (this.running) {
      return;
    }
    const selection = this.getSelectedOption();
    if (selection === null) {
      showNotice('No Dreams model is configured yet. Enable one in Settings first.');
      return;
    }
    this.beginRun(DREAMING_LABEL);
    try {
      await this.runDream(selection);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      showNotice(`Dream failed: ${this.error}`);
    } finally {
      this.running = false;
      this.render();
    }
  }
  private async handlePowerNap(): Promise<void> {
    if (this.running) {
      return;
    }
    this.beginRun(POWER_NAP_LABEL);
    try {
      await this.runPowerNap();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      showNotice(`Power Nap failed: ${this.error}`);
    } finally {
      this.running = false;
      this.render();
    }
  }
  private beginRun(label: string): void {
    this.running = true;
    this.overlayLabel = label;
    this.error = null;
    this.latestPlan = null;
    this.latestExecution = null;
    this.latestRunSnapshot = null;
    this.render();
  }
  private async runDream(selection: ModelOption): Promise<void> {
    const provider = this.plugin.createProviderAdapter(selection.providerId);
    if (provider === undefined) {
      throw new Error(`Could not create provider adapter for ${selection.providerName}.`);
    }
    const snapshotManager = EngramDreamsView.createSnapshotManager();
    const analyzer = new DreamsAnalyzer(this.plugin.memoryManager);
    const snapshot = await snapshotManager.create({
      vaultPath: this.plugin.getVaultBasePath(),
      engramRoot: this.plugin.settings.engramRoot,
      label: 'Dreams pre-run snapshot',
      reason: 'obsidian-dreams-run',
    });
    await analyzer.preCleanup();
    await writeDreamStartEntry(this.plugin.memoryManager);
    const plan = await createDreamPlan({
      selection,
      manager: this.plugin.memoryManager,
      analyzer,
      provider,
      narrativeMaxTokens: NARRATIVE_MAX_TOKENS,
    });
    this.latestPlan = plan;
    const { report } = plan;
    this.report = report;
    this.latestExecution = await this.applyDreamPlan(plan, snapshot);
    this.runHistory = await this.recordDreamRun(selection, plan);
    if (this.latestExecution !== null) {
      await writeDreamScratchEntry({
        manager: this.plugin.memoryManager,
        execution: this.latestExecution,
        actions: plan.actions,
        report: plan.report,
        dream: plan.dream,
      });
    }
    this.snapshots = await snapshotManager.list();
    showNotice(buildDreamCompletionNotice(plan, this.latestExecution));
  }
  private async runPowerNap(): Promise<void> {
    const result = await runPowerNap({
      manager: this.plugin.memoryManager,
      snapshotManager: EngramDreamsView.createSnapshotManager(),
      vaultPath: this.plugin.getVaultBasePath(),
      engramRoot: this.plugin.settings.engramRoot,
    });
    const {
      preCleanup,
      report,
      snapshots,
      snapshot,
    } = result;
    this.report = report;
    this.snapshots = snapshots;
    this.latestRunSnapshot = snapshot;

    showNotice(
      `Power Nap complete: ${preCleanup.tagsFixed} tags fixed, ${preCleanup.tagsNormalized} tags normalized, ${preCleanup.scratchEntriesPurged} scratch entries purged, ${preCleanup.orphanedDreamStartsResolved} orphaned dream starts resolved.`,
    );
  }
  private async applyDreamPlan(
    plan: DreamsPlanResult,
    snapshot: SnapshotRecord,
  ): Promise<DreamsExecutionResult | null> {
    if (plan.actions.length === 0) {
      return null;
    }
    const basePath = this.plugin.getVaultBasePath();
    const config = {
      ...defaultMemoryConfig(basePath, this.plugin.settings.vaultMode),
      engramRoot: this.plugin.settings.engramRoot,
      readPaths: this.plugin.settings.readPaths,
    };
    const execution = await executeDreamsActions({
      actions: plan.actions,
      manager: this.plugin.memoryManager,
      adapter: this.plugin.fileAdapter,
      vaultBasePath: config.basePath,
      engramRoot: config.engramRoot,
      archivePath: config.archivePath,
    });
    this.latestRunSnapshot = snapshot;
    return execution;
  }
  private async recordDreamRun(
    selection: ModelOption,
    plan: DreamsPlanResult,
  ): Promise<DreamsRunHistory> {
    return await appendDreamsRunHistory(
      this.plugin.fileAdapter,
      {
        basePath: this.plugin.getVaultBasePath(),
        engramRoot: this.plugin.settings.engramRoot,
        workingPath: 'working',
        record: createDreamRunRecord(selection, plan, this.latestExecution),
      },
    );
  }
  private async handleCreateSnapshot(): Promise<void> {
    try {
      const snapshot = await EngramDreamsView.createSnapshotManager().create({
        vaultPath: this.plugin.getVaultBasePath(),
        engramRoot: this.plugin.settings.engramRoot,
        label: 'Manual snapshot from Dreams dashboard',
        reason: 'obsidian-dreams-ui',
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
      const result = await EngramDreamsView.createSnapshotManager().restore({
        snapshotIdOrPath: snapshot.id,
        vaultPath: this.plugin.getVaultBasePath(),
        engramRoot: this.plugin.settings.engramRoot,
        label: `Pre-restore safety snapshot for ${snapshot.id}`,
        reason: 'obsidian-dreams-ui-restore',
      });
      showNotice(
        result.safetySnapshot === undefined
          ? `Restored ${snapshot.id}`
          : `Restored ${snapshot.id}. Safety snapshot: ${result.safetySnapshot.id}`,
      );
      this.latestPlan = null;
      this.latestExecution = null;
      this.latestRunSnapshot = null;
      this.plugin.refreshChatView();
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
    return EngramDreamsView.createSnapshotManager().getSnapshotsDir();
  }
  private syncSelection(): ModelOption[] {
    const options = getModelOptions(this.plugin.settings);
    const selection = syncModelSelection(
      this.plugin.settings,
      {
        providerId: this.selectedProviderId,
        modelId: this.selectedModelId,
      },
      options,
    );
    const { providerId, modelId } = selection;
    this.selectedProviderId = providerId;
    this.selectedModelId = modelId;
    return options;
  }
  private getSelectedOption(): ModelOption | null {
    const options = this.syncSelection();
    return findSelectedOption(options, {
      providerId: this.selectedProviderId,
      modelId: this.selectedModelId,
    });
  }
}
