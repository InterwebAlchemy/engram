export interface TypeSegment {
  color: string;
  count: number;
  tokens: number;
  label: string;
}

export interface StateSegment {
  color: string;
  count: number;
  tokens: number;
  label: string;
  types: TypeSegment[];
}

export interface SoulInfo {
  color: string;
  exists: boolean;
  tokens: number;
}

export interface BootstrapInstructionsInfo {
  color: string;
  exists: boolean;
  tokens: number;
}

export interface GlobalInboxInfo {
  bootstrapCount: number;
  bootstrapTokens: number;
  color: string;
  exists: boolean;
  storedCount: number;
  storedTokens: number;
}

export interface ThreadInfo {
  bootstrapCount: number;
  bootstrapTokens: number;
  color: string;
  label: string;
  storedCount: number;
  storedTokens: number;
  threadId: string;
  threadInboxIncluded: boolean;
  threadInboxStoredCount: number;
  threadInboxStoredTokens: number;
  updated: string;
}

export interface ScratchSession {
  color: string;
  entryCount: number;
  label: string;
  sessionId: string;
  tokens: number;
  bootstrapEntryCount: number;
  bootstrapTokens: number;
}

export interface ScratchInfo {
  color: string;
  sessions: ScratchSession[];
  totalEntries: number;
  totalTokens: number;
  bootstrapEntries: number;
  bootstrapTokens: number;
  excludedEntries: number;
  excludedTokens: number;
}

export interface DonutChartData {
  bootstrapCount: number;
  bootstrapInstructions: BootstrapInstructionsInfo;
  bootstrapTokens: number;
  centerLabel: string;
  centerValue: number;
  dreamTargetCount: number;
  globalInbox: GlobalInboxInfo;
  napReclaimCount: number;
  resolvedThreadId: string | null;
  scratch: ScratchInfo;
  soul: SoulInfo;
  stateBreakdown: StateSegment[];
  threads: ThreadInfo[];
  typeColorByLabel: Record<string, string>;
  unit: 'count' | 'tokens';
}

export interface DonutTarget {
  key: string;
  kind: 'bootstrap' | 'inner' | 'outer' | 'overlay';
}

export function sameDonutTarget(a: DonutTarget | null, b: DonutTarget | null): boolean {
  return a?.kind === b?.kind && a?.key === b?.key;
}

export class InteractionState {
  hovered: DonutTarget | null = null;
  selected: DonutTarget | null = null;

  get activeTarget(): DonutTarget | null {
    return this.hovered ?? this.selected;
  }

  clearHover(target: DonutTarget): void {
    if (sameDonutTarget(this.hovered, target)) {
      this.hovered = null;
    }
  }

  setHover(target: DonutTarget): void {
    this.hovered = target;
  }

  toggleSelected(target: DonutTarget): void {
    this.selected = sameDonutTarget(this.selected, target) ? null : target;
  }
}
