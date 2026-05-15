import {
  type ScratchEntry,
  type VaultNote,
  defaultMemoryConfig,
} from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import type { EngramTabId } from '../constants';
import type { EngramTab } from './tab';
import { DreamsAnalyzer } from '../../../dreams/src/analyzer';
import { appendDreamsRunHistory } from '../../../dreams/src/history';
import {
  loadDashboardData,
  loadMemoryArtifacts,
  type ThreadChartData,
} from './dreams-view-dashboard-data';
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
  showNotice,
} from './dreams-view-helpers';
import { renderSummarySection } from './dreams-view-summary';
import {
  confirmDreamRun,
  renderDreamControls,
} from './dreams-view-controls';
import {
  type DreamSelectionState,
  getNarrativeOverrideOption,
  persistDreamSelectionSettings,
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
import { renderDreamerWordsOverlay } from './dreams-view-overlay';
const DREAMS_TAB_TITLE = 'Dreams';
const DREAMS_TAB_ICON = 'moon-star';
const DREAMING_LABEL = 'Dreaming...';
const POWER_NAP_LABEL = 'Power Napping...';
const DREAMING_ANIMATION_MS = 250;
const NARRATIVE_MAX_TOKENS = 512;
const DREAMER_WORDS_DISMISS_TEXT = 'Wake';
export class DreamsTab implements EngramTab {
  readonly id: EngramTabId = 'dreams';
  readonly label = DREAMS_TAB_TITLE;
  readonly icon = DREAMS_TAB_ICON;
  private readonly plugin: EngramPlugin;
  private parent: HTMLElement | null = null;
  private report: DreamsReport | null = null;
  private memoryNotes: VaultNote[] = [];
  private soulNote: VaultNote | null = null;
  private scratchEntries: ScratchEntry[] = [];
  private bootstrapInstructions: string | null = null;
  private threadData: ThreadChartData | null = null;
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
  private dreamerWords: string | null = null;
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
      await this.loadDashboardData();
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
    if (this.dreamerWords !== null) {
      this.dreamCanvas = renderDreamerWordsOverlay({
        parent: this.parent,
        words: this.dreamerWords,
        dismissText: DREAMER_WORDS_DISMISS_TEXT,
        onDismiss: () => {
          this.dreamerWords = null;
          this.render();
        },
      });
      return;
    }
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
    renderSummarySection(this.parent, {
      bootstrapInstructions: this.bootstrapInstructions,
      memoryNotes: this.memoryNotes,
      report: this.report,
      scratchEntries: this.scratchEntries,
      soulNote: this.soulNote,
      threadData: this.threadData,
    });
    renderDreamControls({
      parent: this.parent,
      hasModels: this.syncSelection().length > 0,
      onDream: () => { this.handleDream(); },
      onPowerNap: () => { void this.handlePowerNap(); },
    });
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
  private handleDream(): void {
    if (this.running) {
      return;
    }
    const options = this.syncSelection();
    if (options.length === 0) {
      showNotice('No Dreams model is configured yet. Enable one in Settings first.');
      return;
    }
    confirmDreamRun({
      app: this.plugin.app,
      initialState: this.getSelectionState(),
      onConfirm: (nextSelectionState) => {
        this.applySelectionState(nextSelectionState);
        const selection = findSelectedOption(options, {
          providerId: this.selectedProviderId,
          modelId: this.selectedModelId,
        });
        if (selection === null) {
          showNotice('No Dreams model is configured yet. Enable one in Settings first.');
          return;
        }
        void this.beginDreamRun(selection);
      },
      options,
    });
  }
  private async beginDreamRun(selection: ModelOption): Promise<void> {
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
    this.dreamerWords = null;
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
    const dreamerWords = plan.dream?.trim() ?? '';
    this.dreamerWords = dreamerWords.length > 0 ? dreamerWords : null;
    this.latestPlan = plan;
    const { report } = plan;
    this.report = report;
    this.latestExecution = await this.applyDreamPlan(plan, snapshot);
    await this.recordDreamRun(selection, plan);
    if (this.latestExecution !== null) {
      await writeDreamScratchEntry({
        manager: this.plugin.memoryManager,
        execution: this.latestExecution,
        actions: plan.actions,
        report: plan.report,
        dream: plan.dream,
      });
    }
    await this.loadDashboardData({ includeHistory: false });
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
    const { preCleanup, report, snapshot } = result;
    this.report = report;
    this.latestRunSnapshot = snapshot;
    const { bootstrapInstructions, memoryNotes, soulNote, scratchEntries, threadData } = await loadMemoryArtifacts(this.plugin);
    this.bootstrapInstructions = bootstrapInstructions;
    this.memoryNotes = memoryNotes;
    this.soulNote = soulNote;
    this.scratchEntries = scratchEntries;
    this.threadData = threadData;
    this.plugin.refreshEngramView('snapshots');
    showNotice(`Power Nap complete: ${preCleanup.tagsFixed} tags fixed, ${preCleanup.tagsNormalized} tags normalized, ${preCleanup.scratchEntriesPurged} scratch entries purged, ${preCleanup.orphanedDreamStartsResolved} orphaned dream starts resolved.`);
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
  private async loadDashboardData(options: { includeHistory?: boolean } = {}): Promise<void> {
    const { bootstrapInstructions, report, memoryNotes, soulNote, scratchEntries, threadData } = await loadDashboardData(this.plugin, options);
    this.bootstrapInstructions = bootstrapInstructions;
    this.report = report;
    this.memoryNotes = memoryNotes;
    this.soulNote = soulNote;
    this.scratchEntries = scratchEntries;
    this.threadData = threadData;
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
