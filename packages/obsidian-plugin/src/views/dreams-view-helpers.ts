import {
  Modal,
  Notice,
  type App,
} from 'obsidian';
import { summarizeDreamsUsage } from '../../../dreams/src/history';
import type {
  DreamsAction,
  DreamsExecutionResult,
  DreamsPlanResult,
  DreamsReport,
  DreamsRunHistory,
} from '../../../dreams/src/types';
import type { SnapshotRecord } from '../../../snapshot/src/types';

const PERCENT_SCALE = 100;
const BYTES_PER_KILOBYTE = 1024;
const BYTES_PER_MEGABYTE = BYTES_PER_KILOBYTE * BYTES_PER_KILOBYTE;
const DECIMAL_PRECISION = 1;
const FINDING_LIMIT = 8;
const RECENT_RUN_LIMIT = 5;

export function renderSummarySection(
  parent: HTMLElement,
  report: DreamsReport,
  snapshots: SnapshotRecord[],
): void {
  const { threadHealth } = report;
  const grid = parent.createDiv({ cls: 'engram-dreams-summary-grid' });
  const { size: threadPressureCount } = new Set([
    ...threadHealth.oversizedThreads,
    ...threadHealth.staleThreads,
  ]);

  renderStatCard(grid, 'Memories', `${report.stateDistribution.total}`, 'Total notes tracked by Dreams.');
  renderStatCard(grid, 'Remembered', `${report.stateDistribution.counts.remembered}`, 'Auto-loaded context that should stay intentionally small.');
  renderStatCard(grid, 'Default', `${report.stateDistribution.counts.default}`, 'Background memories available for search or later semantic retrieval.');
  renderStatCard(grid, 'Threads', `${report.threadHealth.totalCount}`, 'Workstreams tracked in `engram/threads`.');
  renderStatCard(grid, 'Thread pressure', `${threadPressureCount}`, 'Threads that look stale or too large and may need consolidation.');
  renderStatCard(grid, 'Thread gaps', `${report.threadCoverageGaps.length}`, 'Notes tagged to a thread namespace but missing `thread:` frontmatter.');
  renderStatCard(grid, 'Data issues', `${report.dataQualityIssues.length}`, 'Missing summaries, bootstrap metadata, or type mismatches.');
  renderStatCard(grid, 'Stale scratch', `${report.scratchHealth.staleSessions.length}`, 'Sessions that still need compaction.');
  renderStatCard(grid, 'Merge candidates', `${report.mergeCandidates.length}`, 'Potential duplicates worth human or LLM review.');
  renderStatCard(grid, 'Snapshots', `${snapshots.length}`, 'Recoverable Engram states available from this vault.');
}

export function renderUsageHistorySection(
  parent: HTMLElement,
  runHistory: DreamsRunHistory | null,
): void {
  const section = parent.createDiv({ cls: 'engram-dreams-section' });
  section.createEl('h4', { text: 'Token history' });

  if (runHistory === null || runHistory.runs.length === 0) {
    section.createDiv({
      cls: 'engram-dreams-empty',
      text: 'No Dream token history yet. Generate a plan to establish a baseline.',
    });
    return;
  }

  const trend = summarizeDreamsUsage(runHistory);
  section.createDiv({
    cls: 'engram-dreams-section-description',
    text: buildUsageHistoryDescription(trend),
  });

  const list = section.createEl('ul', { cls: 'engram-dreams-list' });
  for (const run of runHistory.runs.slice(-RECENT_RUN_LIMIT).reverse()) {
    const item = list.createEl('li');
    item.createDiv({ text: formatRunSummary(run) });
    if (run.dream !== undefined && run.dream.length > 0) {
      item.createDiv({
        cls: 'engram-dreams-stat-description',
        text: run.dream,
      });
    }
  }
}

interface RenderDreamResultsSectionOptions {
  parent: HTMLElement;
  latestPlan: DreamsPlanResult | null;
  latestExecution: DreamsExecutionResult | null;
  latestRunSnapshot: SnapshotRecord | null;
  selectedLabel: string;
}

export function renderDreamResultsSection(options: RenderDreamResultsSectionOptions): void {
  const {
    parent,
    latestPlan,
    latestExecution,
    latestRunSnapshot,
    selectedLabel,
  } = options;
  if (latestPlan === null) {
    return;
  }

  const section = parent.createDiv({ cls: 'engram-dreams-section' });
  section.createEl('h4', { text: 'Latest Dream' });
  section.createDiv({
    cls: 'engram-dreams-section-description',
    text: formatLatestPlanMeta(selectedLabel, latestPlan, latestExecution),
  });

  renderDreamExecutionSummary(section, latestExecution, latestRunSnapshot);

  if (latestPlan.dream !== undefined && latestPlan.dream.length > 0) {
    section.createDiv({
      cls: 'engram-dreams-stat-description',
      text: latestPlan.dream,
    });
  }

  renderCoreReviewFlags(section, latestPlan.actions);

  if (latestExecution !== null && latestExecution.details.length > 0) {
    const executionList = section.createEl('ul', { cls: 'engram-dreams-list' });
    for (const detail of latestExecution.details) {
      executionList.createEl('li', { text: detail });
    }
  }

  const detailsSection = section.createDiv({ cls: 'engram-dreams-plan-details' });
  const rawOutput = detailsSection.createEl('details');
  rawOutput.createEl('summary', { text: 'Raw model output' });
  rawOutput.createEl('pre', {
    cls: 'engram-dreams-raw-output',
    text: latestPlan.rawResponse,
  });
}

export function renderFindingsSections(parent: HTMLElement, report: DreamsReport): void {
  const sections = parent.createDiv({ cls: 'engram-dreams-sections' });

  renderFindingSection(
    sections,
    'Thread pressure',
    report.threadHealth.threads
      .filter((thread) => thread.isOversized || thread.isStale)
      .map((thread) => {
        const flags = [thread.isOversized ? 'oversized' : '', thread.isStale ? 'stale' : '']
          .filter((flag) => flag.length > 0)
          .join(', ');
        const sizeKilobytes = (thread.contentBytes / BYTES_PER_KILOBYTE).toFixed(DECIMAL_PRECISION);
        const suffix = flags.length > 0 ? `, ${flags}` : '';
        return `${thread.threadId} -> ${thread.status}, ${thread.lineCount} lines, ${sizeKilobytes} KB${suffix}`;
      }),
    'Thread docs should stay short, current, and mergeable instead of accreting session history.',
  );

  renderFindingSection(
    sections,
    'Thread coverage gaps',
    report.threadCoverageGaps.map(
      (gap) => `${baseName(gap.path)} -> ${gap.suggestedThreadId ?? 'no suggestion'}`,
    ),
    'Thread tags exist, but scoped retrieval cannot use them until `thread:` is set.',
  );

  renderFindingSection(
    sections,
    'Data quality issues',
    report.dataQualityIssues.map(
      (issue) => `${baseName(issue.path)} -> ${issue.issues.join(', ')}`,
    ),
    'These are the fastest cleanup wins before semantic search lands.',
  );

  renderFindingSection(
    sections,
    'Scratch pressure',
    report.scratchHealth.sessions.map((session) => {
      const status = session.isCompacted ? 'compacted' : 'active';
      return `${session.sessionId} -> ${session.entryCount} entries, ${status}`;
    }),
    'Long-lived uncompacted sessions are a strong Dreams target.',
  );

  renderFindingSection(
    sections,
    'Scratch to thread',
    report.scratchThreadCandidates.map((candidate) => {
      const similarity = `${(candidate.similarity * PERCENT_SCALE).toFixed(0)}%`;
      const threadId = candidate.candidateThreadId ?? 'no clear thread';
      return `${candidate.sessionId} -> ${threadId}, ${candidate.entryCount} entries, ${similarity} overlap`;
    }),
    'Recent scratch can be evidence that a thread doc is stale, missing current state, or already up to date.',
  );

  renderFindingSection(
    sections,
    'Merge candidates',
    report.mergeCandidates.map(
      (candidate) =>
        `${candidate.paths.map(baseName).join(' + ')} -> ${(candidate.similarity * PERCENT_SCALE).toFixed(0)}% similarity`,
    ),
    'These are only heuristics today, so review matters before destructive merges.',
  );
}

export function renderSnapshotsSection(
  parent: HTMLElement,
  snapshots: SnapshotRecord[],
  snapshotsDir: string,
  onRestore: (snapshot: SnapshotRecord) => void,
): void {
  const section = parent.createDiv({ cls: 'engram-dreams-section' });
  section.createEl('h4', { text: 'Snapshots' });
  section.createDiv({
    cls: 'engram-dreams-section-description',
    text: `Stored in ${snapshotsDir}`,
  });

  if (snapshots.length === 0) {
    section.createDiv({
      cls: 'engram-dreams-empty',
      text: 'No snapshots yet. Create one before running a cleanup pass.',
    });
    return;
  }

  const list = section.createDiv({ cls: 'engram-dreams-snapshot-list' });
  for (const snapshot of snapshots.slice(0, FINDING_LIMIT)) {
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
      ]
        .filter((part): part is string => typeof part === 'string' && part.length > 0)
        .join(' · '),
    });

    const restoreButton = row.createEl('button', { text: 'Restore' });
    restoreButton.addEventListener('click', () => {
      onRestore(snapshot);
    });
  }
}

export function showNotice(message: string): Notice {
  return new Notice(message);
}

export function showSnapshotRestoreConfirm(
  app: App,
  snapshotId: string,
  onConfirm: () => void,
): void {
  const modal = new ConfirmDreamsModal(
    app,
    `Restore ${snapshotId}? The current Engram state will be replaced after a safety snapshot is created.`,
    onConfirm,
  );
  modal.open();
}

class ConfirmDreamsModal extends Modal {
  constructor(
    app: App,
    private readonly message: string,
    private readonly onConfirm: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h4', { text: 'Restore snapshot?' });
    contentEl.createEl('p', { text: this.message });

    const actions = contentEl.createDiv({ cls: 'engram-dreams-confirm-actions' });
    const cancelButton = actions.createEl('button', { text: 'Cancel' });
    cancelButton.addEventListener('click', () => {
      this.close();
    });

    const confirmButton = actions.createEl('button', {
      cls: 'mod-warning',
      text: 'Restore',
    });
    confirmButton.addEventListener('click', () => {
      this.confirmAndClose();
    });
  }

  override onClose(): void {
    this.contentEl.empty();
  }

  private confirmAndClose(): void {
    this.onConfirm();
    this.close();
  }
}

function renderDreamExecutionSummary(
  parent: HTMLElement,
  latestExecution: DreamsExecutionResult | null,
  latestRunSnapshot: SnapshotRecord | null,
): void {
  const snapshotLabel = latestRunSnapshot === null ? '' : ` · snapshot ${latestRunSnapshot.id}`;
  parent.createDiv({
    cls: 'engram-dreams-plan-summary engram-dreams-stat-description',
    text: `${latestExecution?.applied ?? 0} applied · ${latestExecution?.skipped ?? 0} skipped${snapshotLabel}`,
  });
}

function renderStatCard(
  parent: HTMLElement,
  label: string,
  value: string,
  description: string,
): void {
  const card = parent.createDiv({ cls: 'engram-dreams-stat-card' });
  card.createDiv({ cls: 'engram-dreams-stat-label', text: label });
  card.createDiv({ cls: 'engram-dreams-stat-value', text: value });
  card.createDiv({ cls: 'engram-dreams-stat-description', text: description });
}

function renderCoreReviewFlags(parent: HTMLElement, actions: DreamsAction[]): void {
  const coreFlags = actions.filter(
    (action): action is Extract<DreamsAction, { action: 'flag_core_review' }> =>
      action.action === 'flag_core_review',
  );
  if (coreFlags.length === 0) {
    return;
  }

  const block = parent.createDiv({ cls: 'engram-dreams-plan-details' });
  block.createEl('h5', { text: 'Core review for next Fragment' });
  block.createDiv({
    cls: 'engram-dreams-section-description',
    text: 'Dreams used core memories as read-only context. These notes were flagged for manual follow-up instead of automatic mutation.',
  });

  const list = block.createEl('ul', { cls: 'engram-dreams-list' });
  for (const flag of coreFlags) {
    const item = list.createEl('li');
    item.createDiv({ text: `${baseName(flag.path)} -> ${flag.concern}` });
    item.createDiv({
      cls: 'engram-dreams-stat-description',
      text: `Suggested: ${flag.suggested_change}`,
    });
    item.createDiv({
      cls: 'engram-dreams-stat-description',
      text: flag.reason,
    });
  }
}

function renderFindingSection(
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
  for (const item of items.slice(0, FINDING_LIMIT)) {
    list.createEl('li', { text: item });
  }
}

function buildUsageHistoryDescription(
  trend: ReturnType<typeof summarizeDreamsUsage>,
): string {
  const descriptionParts: string[] = [];
  const latestUsage = trend.latest?.usage;
  if (latestUsage !== undefined) {
    descriptionParts.push(
      `Latest: ${latestUsage.total_tokens} total (${latestUsage.prompt_tokens} prompt, ${latestUsage.completion_tokens} completion)`,
    );
  }
  if (trend.baselineAverageTotalTokens === undefined) {
    // noop
  } else {
    descriptionParts.push(`Baseline avg: ${trend.baselineAverageTotalTokens} total`);
  }
  if (trend.recentAverageTotalTokens === undefined) {
    // noop
  } else {
    descriptionParts.push(`Recent avg: ${trend.recentAverageTotalTokens} total`);
  }
  if (trend.deltaFromBaseline === undefined) {
    // noop
  } else {
    descriptionParts.push(`Delta from baseline: ${formatSigned(trend.deltaFromBaseline)}`);
  }

  return descriptionParts.join(' · ');
}

function formatRunSummary(run: DreamsRunHistory['runs'][number]): string {
  const totalTokens = run.usage?.total_tokens;
  const usageSummary = totalTokens === undefined
    ? 'usage unavailable'
    : `${totalTokens} total tokens`;

  return [
    formatTimestamp(run.timestamp),
    run.provider,
    run.model,
    usageSummary,
    `${run.reportSummary.memoryCount} memories`,
    `${run.actionCount} actions`,
    run.executionMode,
  ].join(' · ');
}

function baseName(notePath: string): string {
  const fileName = notePath.split('/').at(-1);
  return fileName?.replace(/\.md$/v, '') ?? notePath;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function formatBytes(value?: number): string {
  if (value === undefined || value <= 0) {
    return '0 B';
  }
  if (value >= BYTES_PER_MEGABYTE) {
    return `${(value / BYTES_PER_MEGABYTE).toFixed(DECIMAL_PRECISION)} MB`;
  }
  if (value >= BYTES_PER_KILOBYTE) {
    return `${(value / BYTES_PER_KILOBYTE).toFixed(DECIMAL_PRECISION)} KB`;
  }

  return `${value} B`;
}

function formatLatestPlanMeta(
  selectedLabel: string,
  latestPlan: DreamsPlanResult,
  latestExecution: DreamsExecutionResult | null,
): string {
  const totalTokens = latestPlan.usage?.total_tokens;
  const usageLabel = totalTokens === undefined ? '' : ` · ${totalTokens} tokens`;
  const executionLabel = latestExecution === null
    ? ''
    : ` · ${latestExecution.applied} actions applied`;
  return `${selectedLabel}${usageLabel}${executionLabel}`;
}

function formatSigned(value: number): string {
  if (value <= 0) {
    return `${value}`;
  }

  return `+${value}`;
}
