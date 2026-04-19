import type { EngramTabId } from '../constants';

export interface EngramTab {
  readonly id: EngramTabId;
  readonly label: string;
  readonly icon: string;
  readonly mount: (parent: HTMLElement) => void | Promise<void>;
  readonly unmount: () => void | Promise<void>;
  readonly refresh?: () => void | Promise<void>;
}
