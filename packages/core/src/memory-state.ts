import { MemoryState } from './types';
import type { TokenBudget, Message } from './types';
import { VaultNote } from './vault';

type MemoryItem = VaultNote | Message;

export class MemoryStateManager {
  getState(item: MemoryItem): MemoryState {
    if (item instanceof VaultNote) {
      return (item.frontmatter.memory_state as MemoryState) ?? MemoryState.Default;
    }
    return (item as Message).memoryState ?? MemoryState.Default;
  }

  setState(item: MemoryItem, state: MemoryState): void {
    if (item instanceof VaultNote) {
      item.updateFrontmatter({ memory_state: state });
    } else {
      (item as Message).memoryState = state;
    }
  }

  /**
   * Return all items eligible for context injection, ordered by priority:
   * Core → Remembered → Default. Forgotten items are excluded.
   * Does not enforce the token budget here — ContextBuilder does that.
   */
  getEligible(items: MemoryItem[], _budget: TokenBudget): MemoryItem[] {
    const rank = (item: MemoryItem): number => {
      switch (this.getState(item)) {
        case MemoryState.Core: return 0;
        case MemoryState.Remembered: return 1;
        case MemoryState.Default: return 2;
        case MemoryState.Forgotten: return 3;
      }
    };
    return items
      .filter((i) => this.getState(i) !== MemoryState.Forgotten)
      .sort((a, b) => rank(a) - rank(b));
  }
}
