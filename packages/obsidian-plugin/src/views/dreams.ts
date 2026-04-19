import { defaultMemoryConfig } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import type { EngramTabId } from '../constants';
import type { EngramTab } from './tab';
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
  renderSummarySection,
  renderUsageHistorySection,
  showNotice,
} from './dreams-view-helpers';
import {
  renderDreamControls,
  renderDreamToolbar,
} from './dreams-view-controls';
import {
  type DreamSelectionState,
  getNarrativeOverrideOption,
  persistDreamSelectionSettings,
  updateAnalysisSelection,
  updateNarrativeSelection,
} from './dreams-view-selection';
import {
  buildDreamCompletionNotice,
  createDreamPlan,
  createDreamRunRecord,
  findSelectedOption,
  formatLatestDreamLabel,
  getDreamAnalysisSelection,
  getDreamNarrativeSelection,
  getModelOptions,
  runPowerNap,
  syncModelSelection,
  type ModelOption,
} from './dreams-view-support';
const DREAMS_TAB_TITLE = 'Dreams';
const DREAMS_TAB_ICON = 'moon-star';
const DREAMING_LABEL = 'Dreaming...';
const POWER_NAP_LABEL = 'Power Napping...';
const DREAMING_ANIMATION_MS = 250;
const NARRATIVE_MAX_TOKENS = 512;
export class DreamsTab implements EngramTab {
  readonly id: EngramTabId = 'dreams';
  readonly label = DREAMS_TAB_TITLE;
  readonly icon = DREAMS_TAB_ICON;
  private readonly plugin: EngramPlugin;
  private parent: HTMLElement | null = null;
  private report: DreamsReport | null = null;
  private snapshotCount = 0;
  private runHistory: DreamsRunHistory | null = null;
  private latestPlan: DreamsPlanResult | null = null;
  private latestExecution: DreamsExecutionResult | null = null;
  private latestRunSnapshot: SnapshotRecord | null = null;
  private loading = false;
  private running = false;
  private error: string | null = null;
  private selectedProviderId = '';
  private selectedModelId = '';
  private narrativeProviderId = '';
  private narrativeModelId = '';
  private dreamCanvas: DreamCanvas | null = null;
  private dreamAnimator: Ciph3rTextAnimator | null = null;
  private overlayLabel = DREAMING_LABEL;
  constructor(plugin: EngramPlugin) {
    this.plugin = plugin;
  }
  mount(parent: HTMLElement): void {
    parent.empty();
    parent.addClass('engram-dreams-container');
    this.parent = parent;
    this.syncSelection();
    void this.refresh();
  }
  unmount(): void {
    this.cleanupDreamOverlay();
    if (this.parent !== null) {
      this.parent.empty();
      this.parent.removeClass('engram-dreams-container');
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
      const analyzer = new DreamsAnalyzer(this.plugin.memoryManager);
      const snapshotManager = DreamsTab.createSnapshotManager();
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
      const { length: snapshotCount } = snapshots;
      this.snapshotCount = snapshotCount;
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
    if (this.parent === null) {
      return;
    }
    this.cleanupDreamOverlay();
    this.parent.empty();
    if (this.running) {
      this.renderDreamingOverlay();
      return;
    }
    renderDreamToolbar({
      parent: this.parent.createDiv({ cls: 'engram-dreams-toolbar' }),
      onRefresh: () => { void this.refresh(); },
    });
    renderDreamControls({
      parent: this.parent,
      options: this.syncSelection(),
      selectedProviderId: this.selectedProviderId,
      selectedModelId: this.selectedModelId,
      narrativeProviderId: this.narrativeProviderId,
      narrativeModelId: this.narrativeModelId,
      onModelChange: (providerId, modelId) => {
        this.setAnalysisSelection(providerId, modelId);
      },
      onNarrativeChange: (providerId, modelId) => {
        this.setNarrativeSelection(providerId, modelId);
      },
      onDream: () => { void this.handleDream(); },
      onPowerNap: () => { void this.handlePowerNap(); },
    });
    if (this.loading) {
      this.parent.createDiv({
        cls: 'engram-dreams-empty',
        text: 'Analyzing vault health...',
      });
      return;
    }
    if (this.error !== null) {
      this.parent.createDiv({
        cls: 'engram-dreams-empty',
        text: `Could not load Dreams dashboard: ${this.error}`,
      });
      return;
    }
    if (this.report === null) {
      this.parent.createDiv({
        cls: 'engram-dreams-empty',
        text: 'No Dreams report available yet.',
      });
      return;
    }
    renderSummarySection(this.parent, this.report, this.snapshotCount);
    renderUsageHistorySection(this.parent, this.runHistory);
    renderDreamResultsSection({
      parent: this.parent,
      latestPlan: this.latestPlan,
      latestExecution: this.latestExecution,
      latestRunSnapshot: this.latestRunSnapshot,
      selectedLabel: formatLatestDreamLabel(
        findSelectedOption(getModelOptions(this.plugin.settings), {
          providerId: this.selectedProviderId,
          modelId: this.selectedModelId,
        }),
        this.latestPlan,
        this.latestExecution,
      ),
    });
    renderFindingsSections(this.parent, this.report);
  }
  private renderDreamingOverlay(): void {
    if (this.parent === null) {
      return;
    }
    const overlay = this.parent.createDiv({ cls: 'engram-dreams-overlay' });
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
    const selection = findSelectedOption(this.syncSelection(), {
      providerId: this.selectedProviderId,
      modelId: this.selectedModelId,
    });
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
    const narrativeOverride = getNarrativeOverrideOption(this.plugin, {
      analysisSelection: { providerId: this.selectedProviderId, modelId: this.selectedModelId },
      narrativeSelection: { providerId: this.narrativeProviderId, modelId: this.narrativeModelId },
    });
    const narrativeProvider = narrativeOverride === null
      ? undefined
      : this.plugin.createProviderAdapter(narrativeOverride.providerId);
    if (narrativeOverride !== null) {
      if (narrativeProvider === undefined) {
        throw new Error(
          `Could not create narrative provider adapter for ${narrativeOverride.providerName}.`,
        );
      }
    }
    const snapshotManager = DreamsTab.createSnapshotManager();
    const analyzer = new DreamsAnalyzer(this.plugin.memoryManager);
    const snapshot = await snapshotManager.create({
      vaultPath: this.plugin.getVaultBasePath(), engramRoot: this.plugin.settings.engramRoot,
      label: 'Dreams pre-run snapshot', reason: 'obsidian-dreams-run',
    });
    await analyzer.preCleanup();
    await writeDreamStartEntry(this.plugin.memoryManager);
    const plan = await createDreamPlan({
      selection, manager: this.plugin.memoryManager, analyzer, provider,
      narrativeMaxTokens: NARRATIVE_MAX_TOKENS,
      narrativeSelection: narrativeOverride ?? undefined,
      narrativeProvider,
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
    const { length: snapshotCount } = await snapshotManager.list();
    this.snapshotCount = snapshotCount;
    this.plugin.refreshEngramView('snapshots');
    showNotice(buildDreamCompletionNotice(plan, this.latestExecution));
  }
  private async runPowerNap(): Promise<void> {
    const result = await runPowerNap({
      manager: this.plugin.memoryManager,
      snapshotManager: DreamsTab.createSnapshotManager(),
      vaultPath: this.plugin.getVaultBasePath(),
      engramRoot: this.plugin.settings.engramRoot,
    });
    const { preCleanup, report, snapshots, snapshot } = result;
    this.report = report;
    const { length: snapshotCount } = snapshots;
    this.snapshotCount = snapshotCount;
    this.latestRunSnapshot = snapshot;
    this.plugin.refreshEngramView('snapshots');
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
      { basePath: this.plugin.getVaultBasePath(), engramRoot: this.plugin.settings.engramRoot,
        workingPath: 'working', record: createDreamRunRecord(selection, plan, this.latestExecution) },
    );
  }
  private static createSnapshotManager(): SnapshotManager {
    return new SnapshotManager();
  }
  private syncSelection(): ModelOption[] {
    const options = getModelOptions(this.plugin.settings);
    const analysisFallback = getDreamAnalysisSelection(this.plugin.settings, options);
    const selection = syncModelSelection(
      this.plugin.settings,
      { providerId: this.selectedProviderId, modelId: this.selectedModelId },
      options,
      analysisFallback,
    );
    const narrativeFallback = getDreamNarrativeSelection(
      this.plugin.settings,
      options,
      selection,
    );
    const narrativeSelection = syncModelSelection(
      this.plugin.settings,
      { providerId: this.narrativeProviderId, modelId: this.narrativeModelId },
      options,
      narrativeFallback,
    );
    this.applySelectionState({
      analysisSelection: selection,
      narrativeSelection,
    });
    return options;
  }
  private setAnalysisSelection(providerId: string, modelId: string): void {
    this.applySelectionState(
      updateAnalysisSelection(this.getSelectionState(), providerId, modelId),
    );
  }
  private setNarrativeSelection(providerId: string, modelId: string): void {
    this.applySelectionState(
      updateNarrativeSelection(this.getSelectionState(), providerId, modelId),
    );
  }
  private getSelectionState(): DreamSelectionState {
    return {
      analysisSelection: { providerId: this.selectedProviderId, modelId: this.selectedModelId },
      narrativeSelection: { providerId: this.narrativeProviderId, modelId: this.narrativeModelId },
    };
  }
  private applySelectionState(state: DreamSelectionState): void {
    const {
      analysisSelection: { providerId: analysisProviderId, modelId: analysisModelId },
      narrativeSelection: { providerId: narrativeProviderId, modelId: narrativeModelId },
    } = state;
    this.selectedProviderId = analysisProviderId;
    this.selectedModelId = analysisModelId;
    this.narrativeProviderId = narrativeProviderId;
    this.narrativeModelId = narrativeModelId;
    persistDreamSelectionSettings(this.plugin, state);
  }
}
