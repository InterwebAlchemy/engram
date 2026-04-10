import * as path from 'path';
import { ItemView, Notice, WorkspaceLeaf, setIcon } from 'obsidian';
import {
  defaultMemoryConfig,
  type ChatMessage,
} from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';
import { DREAMS_VIEW_TYPE, KNOWN_MODELS } from '../constants';
import { DreamsAnalyzer } from '../../../dreams/src/analyzer';
import {
  appendDreamsRunHistory,
  readDreamsRunHistory,
  summarizeDreamsUsage,
} from '../../../dreams/src/history';
import {
  buildDryRunExecution,
  describeAction,
  executeDreamsActions,
  planDreams,
} from '../../../dreams/src/runner';
import type {
  DreamsAction,
  DreamsRunHistory,
  DreamsExecutionResult,
  DreamsPlanResult,
  DreamsReport,
} from '../../../dreams/src/types';
import { SnapshotManager } from '../../../snapshot/src/manager';
import type { SnapshotRecord } from '../../../snapshot/src/types';

interface ModelOption {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
}

export class EngramDreamsView extends ItemView {
  private readonly plugin: EngramPlugin;
  private container!: HTMLElement;
  private report: DreamsReport | null = null;
  private snapshots: SnapshotRecord[] = [];
  private runHistory: DreamsRunHistory | null = null;
  private latestPlan: DreamsPlanResult | null = null;
  private latestExecution: DreamsExecutionResult | null = null;
  private latestRunSnapshot: SnapshotRecord | null = null;
  private loading = false;
  private planning = false;
  private applying = false;
  private error: string | null = null;
  private selectedProviderId = '';
  private selectedModelId = '';

  constructor(leaf: WorkspaceLeaf, plugin: EngramPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return DREAMS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'Engram Dreams';
  }

  getIcon(): string {
    return 'moon-star';
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass('engram-dreams-container');
    this.container = container;
    this.ensureSelection();
    await this.refresh();
  }

  async onClose(): Promise<void> {
    // Nothing to clean up.
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    this.render();

    try {
      const analyzer = new DreamsAnalyzer(this.plugin.memoryManager);
      const snapshotManager = this.createSnapshotManager();
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
      this.ensureSelection();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private render(): void {
    this.container.empty();

    const toolbar = this.container.createDiv({ cls: 'engram-dreams-toolbar' });
    this.renderToolbar(toolbar);
    this.renderControls(this.container);

    if (this.loading) {
      this.container.createDiv({
        cls: 'engram-dreams-empty',
        text: 'Analyzing vault health and loading snapshots...',
      });
      return;
    }

    if (this.error) {
      this.container.createDiv({
        cls: 'engram-dreams-empty',
        text: `Could not load Dreams dashboard: ${this.error}`,
      });
      return;
    }

    if (!this.report) {
      this.container.createDiv({
        cls: 'engram-dreams-empty',
        text: 'No Dreams report available yet.',
      });
      return;
    }

    this.renderSummary(this.container, this.report, this.snapshots);
    this.renderUsageHistory(this.container);
    this.renderPlanResults(this.container);
    this.renderFindings(this.container, this.report);
    this.renderSnapshots(this.container, this.snapshots);
  }

  private renderToolbar(parent: HTMLElement): void {
    const titleGroup = parent.createDiv({ cls: 'engram-dreams-toolbar-copy' });
    titleGroup.createEl('h3', { text: 'Dreams dashboard' });
    titleGroup.createEl('p', {
      cls: 'setting-item-description',
      text: 'Inspect vault health, plan memory cleanup, and run Dreams from the place where the memories live.',
    });

    const actions = parent.createDiv({ cls: 'engram-dreams-toolbar-actions' });

    const refreshButton = actions.createEl('button', {
      cls: 'engram-toolbar-btn',
      attr: { 'aria-label': 'Refresh Dreams dashboard' },
    });
    setIcon(refreshButton, 'refresh-cw');
    refreshButton.addEventListener('click', () => {
      void this.refresh();
    });

    const snapshotButton = actions.createEl('button', {
      cls: 'mod-cta',
      text: 'Create snapshot',
    });
    snapshotButton.addEventListener('click', () => {
      void this.handleCreateSnapshot();
    });
  }

  private renderControls(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: 'engram-dreams-controls' });
    const copy = section.createDiv({ cls: 'engram-dreams-controls-copy' });
    copy.createEl('h4', { text: 'Run Dreams' });
    copy.createDiv({
      cls: 'engram-dreams-section-description',
      text: 'Generate a cleanup plan with a model you trust, then apply that plan with a safety snapshot.',
    });

    const options = this.getModelOptions();
    this.ensureSelection(options);

    const form = section.createDiv({ cls: 'engram-dreams-controls-form' });
    const modelSelect = form.createEl('select', {
      cls: 'engram-filter-select',
      attr: { 'aria-label': 'Dreams provider and model' },
    });

    if (options.length === 0) {
      modelSelect.createEl('option', {
        value: '',
        text: 'No enabled models. Configure one in Settings.',
      });
      modelSelect.disabled = true;
    } else {
      for (const option of options) {
        modelSelect.createEl('option', {
          value: `${option.providerId}::${option.modelId}`,
          text: `${option.providerName} - ${option.modelName}`,
        });
      }
      modelSelect.value = `${this.selectedProviderId}::${this.selectedModelId}`;
      modelSelect.addEventListener('change', () => {
        const [providerId, modelId] = modelSelect.value.split('::');
        this.selectedProviderId = providerId ?? '';
        this.selectedModelId = modelId ?? '';
      });
    }

    const planButton = form.createEl('button', {
      cls: 'mod-cta',
      text: this.planning ? 'Planning...' : 'Plan dreams',
    });
    planButton.disabled = this.planning || this.applying || options.length === 0;
    planButton.addEventListener('click', () => {
      void this.handlePlanDreams();
    });

    const applyButton = form.createEl('button', {
      text: this.applying ? 'Applying...' : 'Apply current plan',
    });
    applyButton.disabled =
      this.planning ||
      this.applying ||
      !this.latestPlan ||
      this.latestPlan.actions.length === 0;
    applyButton.addEventListener('click', () => {
      void this.handleApplyDreams();
    });
  }

  private renderSummary(parent: HTMLElement, report: DreamsReport, snapshots: SnapshotRecord[]): void {
    const grid = parent.createDiv({ cls: 'engram-dreams-summary-grid' });

    const rememberedCount = report.stateDistribution.counts.remembered ?? 0;
    const defaultCount = report.stateDistribution.counts.default ?? 0;

    this.renderStatCard(grid, 'Memories', String(report.stateDistribution.total), 'Total notes tracked by Dreams.');
    this.renderStatCard(grid, 'Remembered', String(rememberedCount), 'Auto-loaded context that should stay intentionally small.');
    this.renderStatCard(grid, 'Default', String(defaultCount), 'Background memories available for search or later semantic retrieval.');
    this.renderStatCard(grid, 'Thread gaps', String(report.threadCoverageGaps.length), 'Notes tagged to a thread namespace but missing `thread:` frontmatter.');
    this.renderStatCard(grid, 'Data issues', String(report.dataQualityIssues.length), 'Missing summaries, bootstrap metadata, or type mismatches.');
    this.renderStatCard(grid, 'Stale scratch', String(report.scratchHealth.staleSessions.length), 'Sessions that still need compaction.');
    this.renderStatCard(grid, 'Merge candidates', String(report.mergeCandidates.length), 'Potential duplicates worth human or LLM review.');
    this.renderStatCard(grid, 'Snapshots', String(snapshots.length), 'Recoverable Engram states available from this vault.');
  }

  private renderStatCard(parent: HTMLElement, label: string, value: string, description: string): void {
    const card = parent.createDiv({ cls: 'engram-dreams-stat-card' });
    card.createDiv({ cls: 'engram-dreams-stat-label', text: label });
    card.createDiv({ cls: 'engram-dreams-stat-value', text: value });
    card.createDiv({ cls: 'engram-dreams-stat-description', text: description });
  }

  private renderUsageHistory(parent: HTMLElement): void {
    const section = parent.createDiv({ cls: 'engram-dreams-section' });
    section.createEl('h4', { text: 'Token history' });

    const history = this.runHistory;
    if (!history || history.runs.length === 0) {
      section.createDiv({
        cls: 'engram-dreams-empty',
        text: 'No Dream token history yet. Generate a plan to establish a baseline.',
      });
      return;
    }

    const trend = summarizeDreamsUsage(history);
    const latest = trend.latest;
    const baseline = trend.baselineAverageTotalTokens;
    const recent = trend.recentAverageTotalTokens;
    const delta = trend.deltaFromBaseline;

    section.createDiv({
      cls: 'engram-dreams-section-description',
      text: [
        latest?.usage
          ? `Latest: ${latest.usage.total_tokens} total (${latest.usage.prompt_tokens} prompt, ${latest.usage.completion_tokens} completion)`
          : undefined,
        baseline !== undefined ? `Baseline avg: ${baseline} total` : undefined,
        recent !== undefined ? `Recent avg: ${recent} total` : undefined,
        delta !== undefined ? `Delta from baseline: ${formatSigned(delta)}` : undefined,
      ].filter(Boolean).join(' · '),
    });

    const list = section.createEl('ul', { cls: 'engram-dreams-list' });
    for (const run of history.runs.slice(-5).reverse()) {
      list.createEl('li', {
        text: [
          formatTimestamp(run.timestamp),
          run.provider,
          run.model,
          run.usage?.total_tokens !== undefined ? `${run.usage.total_tokens} total tokens` : 'usage unavailable',
          `${run.reportSummary.memoryCount} memories`,
          `${run.actionCount} actions`,
          run.executionMode,
        ].join(' · '),
      });
    }
  }

  private renderPlanResults(parent: HTMLElement): void {
    if (!this.latestPlan) return;

    const section = parent.createDiv({ cls: 'engram-dreams-section' });
    section.createEl('h4', { text: 'Latest Dreams plan' });
    section.createDiv({
      cls: 'engram-dreams-section-description',
      text: this.formatLatestPlanMeta(),
    });

    const dryRun = buildDryRunExecution(this.latestPlan.actions);
    const summary = section.createDiv({ cls: 'engram-dreams-plan-summary' });
    summary.createDiv({
      cls: 'engram-dreams-stat-description',
      text: `${this.latestPlan.actions.length} proposed actions · ${this.latestPlan.reviewNotes.length} review notes supplied to the model`,
    });

    const actionsList = section.createDiv({ cls: 'engram-dreams-action-list' });
    if (this.latestPlan.actions.length === 0) {
      actionsList.createDiv({
        cls: 'engram-dreams-empty',
        text: 'The model proposed no actions.',
      });
    } else {
      for (const action of this.latestPlan.actions) {
        this.renderActionCard(actionsList, action);
      }
    }

    const detailsSection = section.createDiv({ cls: 'engram-dreams-plan-details' });
    const preview = detailsSection.createEl('details');
    preview.createEl('summary', { text: 'Dry-run execution preview' });
    const previewList = preview.createEl('ul', { cls: 'engram-dreams-list' });
    for (const detail of dryRun.details) {
      previewList.createEl('li', { text: detail });
    }

    const rawOutput = detailsSection.createEl('details');
    rawOutput.createEl('summary', { text: 'Raw model output' });
    rawOutput.createEl('pre', {
      cls: 'engram-dreams-raw-output',
      text: this.latestPlan.rawResponse,
    });

    if (this.latestExecution) {
      const execution = section.createDiv({ cls: 'engram-dreams-execution' });
      execution.createEl('h5', { text: 'Latest execution' });
      execution.createDiv({
        cls: 'engram-dreams-section-description',
        text: `${this.latestExecution.applied} applied · ${this.latestExecution.skipped} skipped${this.latestRunSnapshot ? ` · snapshot ${this.latestRunSnapshot.id}` : ''}`,
      });

      const executionList = execution.createEl('ul', { cls: 'engram-dreams-list' });
      for (const detail of this.latestExecution.details) {
        executionList.createEl('li', { text: detail });
      }
    }
  }

  private renderActionCard(parent: HTMLElement, action: DreamsAction): void {
    const card = parent.createDiv({ cls: 'engram-dreams-action-card' });
    card.createDiv({
      cls: 'engram-dreams-action-title',
      text: describeAction(action),
    });
    const reason = 'reason' in action ? action.reason : 'No reason provided.';
    card.createDiv({
      cls: 'engram-dreams-section-description',
      text: reason,
    });
  }

  private renderFindings(parent: HTMLElement, report: DreamsReport): void {
    const sections = parent.createDiv({ cls: 'engram-dreams-sections' });

    this.renderFindingSection(
      sections,
      'Thread coverage gaps',
      report.threadCoverageGaps.map((gap) => `${baseName(gap.path)} -> ${gap.suggestedThreadId ?? 'no suggestion'}`),
      'Thread tags exist, but scoped retrieval cannot use them until `thread:` is set.',
    );

    this.renderFindingSection(
      sections,
      'Data quality issues',
      report.dataQualityIssues.map((issue) => `${baseName(issue.path)} -> ${issue.issues.join(', ')}`),
      'These are the fastest cleanup wins before semantic search lands.',
    );

    this.renderFindingSection(
      sections,
      'Scratch pressure',
      report.scratchHealth.sessions.map((session) => {
        const status = session.isCompacted ? 'compacted' : 'active';
        return `${session.sessionId} -> ${session.entryCount} entries, ${status}`;
      }),
      'Long-lived uncompacted sessions are a strong Dreams target.',
    );

    this.renderFindingSection(
      sections,
      'Merge candidates',
      report.mergeCandidates.map((candidate) => `${candidate.paths.map(baseName).join(' + ')} -> ${(candidate.similarity * 100).toFixed(0)}% similarity`),
      'These are only heuristics today, so review matters before destructive merges.',
    );
  }

  private renderFindingSection(
    parent: HTMLElement,
    title: string,
    items: string[],
    description: string,
  ): void {
    const section = parent.createDiv({ cls: 'engram-dreams-section' });
    section.createEl('h4', { text: title });
    section.createDiv({ cls: 'engram-dreams-section-description', text: description });

    if (items.length === 0) {
      section.createDiv({ cls: 'engram-dreams-empty', text: 'No issues surfaced.' });
      return;
    }

    const list = section.createEl('ul', { cls: 'engram-dreams-list' });
    for (const item of items.slice(0, 8)) {
      list.createEl('li', { text: item });
    }
  }

  private renderSnapshots(parent: HTMLElement, snapshots: SnapshotRecord[]): void {
    const section = parent.createDiv({ cls: 'engram-dreams-section' });
    section.createEl('h4', { text: 'Snapshots' });
    section.createDiv({
      cls: 'engram-dreams-section-description',
      text: `Stored in ${this.getSnapshotsDir()}`,
    });

    if (snapshots.length === 0) {
      section.createDiv({
        cls: 'engram-dreams-empty',
        text: 'No snapshots yet. Create one before running a cleanup pass.',
      });
      return;
    }

    const list = section.createDiv({ cls: 'engram-dreams-snapshot-list' });
    for (const snapshot of snapshots.slice(0, 8)) {
      const row = list.createDiv({ cls: 'engram-dreams-snapshot-row' });
      const copy = row.createDiv({ cls: 'engram-dreams-snapshot-copy' });
      copy.createDiv({ cls: 'engram-dreams-snapshot-title', text: snapshot.id });
      copy.createDiv({
        cls: 'engram-dreams-snapshot-meta',
        text: [
          formatTimestamp(snapshot.createdAt),
          formatBytes(snapshot.sizeBytes),
          snapshot.source,
          snapshot.label,
          snapshot.reason,
        ].filter(Boolean).join(' · '),
      });

      const restoreButton = row.createEl('button', { text: 'Restore' });
      restoreButton.addEventListener('click', () => {
        void this.handleRestoreSnapshot(snapshot);
      });
    }
  }

  private async handlePlanDreams(): Promise<void> {
    const selection = this.getSelectedOption();
    if (!selection) {
      new Notice('No Dreams model is configured yet. Enable one in Settings first.');
      return;
    }

    this.planning = true;
    this.error = null;
    this.latestExecution = null;
    this.latestRunSnapshot = null;
    this.render();

    try {
      const provider = await this.plugin.createProviderAdapter(selection.providerId);
      if (!provider) {
        throw new Error(`Could not create provider adapter for ${selection.providerName}.`);
      }

      const analyzer = new DreamsAnalyzer(this.plugin.memoryManager);
      const plan = await planDreams(
        this.plugin.memoryManager,
        () => analyzer.analyze(),
        async (messages) => {
          const result = await provider.complete(messages as ChatMessage[], {
            model: selection.modelId,
            temperature: 0,
            maxTokens: 4000,
          });
          return {
            content: result.content.trim(),
            usage: result.usage,
          };
        },
      );

      this.latestPlan = plan;
      this.report = plan.report;
      this.runHistory = await appendDreamsRunHistory(
        this.plugin.fileAdapter,
        this.plugin.getVaultBasePath(),
        this.plugin.settings.engramRoot,
        'working',
        {
          id: `dream-${new Date().toISOString().replace(/[:.]/g, '').replace('Z', 'Z')}`,
          timestamp: new Date().toISOString(),
          provider: selection.providerId,
          model: selection.modelId,
          usage: plan.usage,
          actionCount: plan.actions.length,
          reviewNoteCount: plan.reviewNotes.length,
          executionMode: 'plan',
          reportSummary: {
            memoryCount: plan.report.stateDistribution.total,
            rememberedCount: plan.report.stateDistribution.counts.remembered ?? 0,
            defaultCount: plan.report.stateDistribution.counts.default ?? 0,
            threadGapCount: plan.report.threadCoverageGaps.length,
            dataQualityIssueCount: plan.report.dataQualityIssues.length,
            mergeCandidateCount: plan.report.mergeCandidates.length,
            scratchEntryCount: plan.report.scratchHealth.entryCount,
            staleScratchSessionCount: plan.report.scratchHealth.staleSessions.length,
          },
        },
      );
      this.snapshots = await this.createSnapshotManager().list();
      const usageLabel = plan.usage?.total_tokens ? ` ${plan.usage.total_tokens} tokens.` : '';
      new Notice(`Dreams plan ready: ${plan.actions.length} actions proposed.${usageLabel}`);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      new Notice(`Dreams planning failed: ${this.error}`);
    } finally {
      this.planning = false;
      this.render();
    }
  }

  private async handleApplyDreams(): Promise<void> {
    if (!this.latestPlan) {
      new Notice('Plan Dreams first so there is something to apply.');
      return;
    }

    if (this.latestPlan.actions.length === 0) {
      new Notice('The current Dreams plan has no actions to apply.');
      return;
    }

    const confirmed = window.confirm(
      `Apply ${this.latestPlan.actions.length} Dreams actions to this vault? A rollback snapshot will be created first.`,
    );
    if (!confirmed) return;

    this.applying = true;
    this.error = null;
    this.render();

    try {
      const snapshot = await this.createSnapshotManager().create({
        vaultPath: this.plugin.getVaultBasePath(),
        engramRoot: this.plugin.settings.engramRoot,
        label: 'Dreams pre-run snapshot',
        reason: 'obsidian-dreams-run',
      });

      const basePath = this.plugin.getVaultBasePath();
      const config = {
        ...defaultMemoryConfig(basePath, this.plugin.settings.vaultMode),
        engramRoot: this.plugin.settings.engramRoot,
        readPaths: this.plugin.settings.readPaths,
      };

      this.latestExecution = await executeDreamsActions(
        this.latestPlan.actions,
        this.plugin.memoryManager,
        this.plugin.fileAdapter,
        config.basePath,
        config.engramRoot,
        config.archivePath,
      );
      this.latestRunSnapshot = snapshot;

      await this.refresh();
      new Notice(`Dreams applied ${this.latestExecution.applied} actions. Snapshot: ${snapshot.id}`);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      new Notice(`Dreams apply failed: ${this.error}`);
    } finally {
      this.applying = false;
      this.render();
    }
  }

  private async handleCreateSnapshot(): Promise<void> {
    try {
      const snapshot = await this.createSnapshotManager().create({
        vaultPath: this.plugin.getVaultBasePath(),
        engramRoot: this.plugin.settings.engramRoot,
        label: 'Manual snapshot from Dreams dashboard',
        reason: 'obsidian-dreams-ui',
      });
      new Notice(`Snapshot created: ${snapshot.id}`);
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Snapshot failed: ${message}`);
    }
  }

  private async handleRestoreSnapshot(snapshot: SnapshotRecord): Promise<void> {
    const confirmed = window.confirm(
      `Restore ${snapshot.id}? The current Engram state will be replaced after a safety snapshot is created.`,
    );
    if (!confirmed) return;

    try {
      const result = await this.createSnapshotManager().restore({
        snapshotIdOrPath: snapshot.id,
        vaultPath: this.plugin.getVaultBasePath(),
        engramRoot: this.plugin.settings.engramRoot,
        label: `Pre-restore safety snapshot for ${snapshot.id}`,
        reason: 'obsidian-dreams-ui-restore',
      });
      new Notice(
        result.safetySnapshot
          ? `Restored ${snapshot.id}. Safety snapshot: ${result.safetySnapshot.id}`
          : `Restored ${snapshot.id}`,
      );
      this.latestPlan = null;
      this.latestExecution = null;
      this.latestRunSnapshot = null;
      this.plugin.refreshChatView();
      await this.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Restore failed: ${message}`);
    }
  }

  private createSnapshotManager(): SnapshotManager {
    return new SnapshotManager({ snapshotsDir: this.getSnapshotsDir() });
  }

  private getSnapshotsDir(): string {
    return path.join(this.plugin.getVaultBasePath(), '.snapshots', 'engram');
  }

  private ensureSelection(options: ModelOption[] = this.getModelOptions()): void {
    const currentExists = options.some(
      (option) =>
        option.providerId === this.selectedProviderId &&
        option.modelId === this.selectedModelId,
    );
    if (currentExists) return;

    const activeProviderId = this.plugin.settings.activeProviderId;
    const activeModelId = this.plugin.settings.providers[activeProviderId]?.defaultModel ?? '';
    const preferred = options.find(
      (option) => option.providerId === activeProviderId && option.modelId === activeModelId,
    );
    const fallback = preferred ?? options[0];

    this.selectedProviderId = fallback?.providerId ?? '';
    this.selectedModelId = fallback?.modelId ?? '';
  }

  private getModelOptions(): ModelOption[] {
    const options: ModelOption[] = [];

    for (const [providerId, cfg] of Object.entries(this.plugin.settings.providers)) {
      const enabledModels = cfg.enabledModels ?? [];
      for (const modelId of enabledModels) {
        const modelName =
          KNOWN_MODELS[providerId]?.find((model) => model.id === modelId)?.name ?? modelId;
        options.push({
          providerId,
          providerName: cfg.name,
          modelId,
          modelName,
        });
      }
    }

    return options;
  }

  private getSelectedOption(): ModelOption | null {
    const options = this.getModelOptions();
    this.ensureSelection(options);
    return options.find(
      (option) =>
        option.providerId === this.selectedProviderId &&
        option.modelId === this.selectedModelId,
    ) ?? null;
  }

  private formatLatestPlanMeta(): string {
    const selected = this.getSelectedOption();
    const providerLabel = selected
      ? `${selected.providerName} · ${selected.modelName}`
      : 'Unknown model';
    const usageLabel = this.latestPlan?.usage?.total_tokens
      ? ` · ${this.latestPlan.usage.total_tokens} tokens`
      : '';
    const executionLabel = this.latestExecution
      ? ` · ${this.latestExecution.applied} actions applied`
      : '';
    return `${providerLabel}${usageLabel}${executionLabel}`;
  }
}

function baseName(notePath: string): string {
  return notePath.split('/').pop()?.replace(/\.md$/, '') ?? notePath;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function formatBytes(value?: number): string {
  if (!value || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSigned(value: number): string {
  return `${value > 0 ? '+' : ''}${value}`;
}
