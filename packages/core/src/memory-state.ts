import { MemoryState } from './types.js';
import type { TokenBudget, Message } from './types.js';
import { VaultNote } from './vault.js';

type MemoryItem = VaultNote | Message;

const rankByState: Record<MemoryState, number> = {
  [MemoryState.Core]: 0,
  [MemoryState.Remembered]: 1,
  [MemoryState.Default]: 2,
  [MemoryState.Forgotten]: 3,
};

export const MemoryStateManager = {
  getState(item: MemoryItem): MemoryState {
    if (item instanceof VaultNote) {
      return item.frontmatter.memory_state ?? MemoryState.Default;
    }
    return item.memoryState;
  },

  setState(item: MemoryItem, state: MemoryState): void {
    if (item instanceof VaultNote) {
      item.updateFrontmatter({ memory_state: state });
    } else {
      const nextItem = item;
      nextItem.memoryState = state;
    }
  },

  /**
   * Return all items eligible for context injection, ordered by priority:
   * Core → Remembered → Default. Forgotten items are excluded.
   * Does not enforce the token budget here — ContextBuilder does that.
   */
  getEligible(items: MemoryItem[], _budget: TokenBudget): MemoryItem[] {
    const rank = (item: MemoryItem): number => rankByState[MemoryStateManager.getState(item)];
    return items
      .filter((item) => MemoryStateManager.getState(item) !== MemoryState.Forgotten)
      .sort((a, b) => rank(a) - rank(b));
  },
};
