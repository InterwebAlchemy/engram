import * as yaml from 'yaml';
import { MemoryState } from './types';
import type { Message, TokenBudget, ConversationFrontmatter } from './types';
import { VaultNote } from './vault';
import { ContextBuilder } from './context';

export class Conversation {
  constructor(
    public messages: Message[] = [],
    public frontmatter: ConversationFrontmatter = Conversation.defaultFrontmatter(),
  ) {}

  // ─── Mutation ─────────────────────────────────────────────────────────────

  addMessage(message: Message): void {
    this.messages.push(message);
    this.frontmatter.message_count = this.messages.length;
    this.frontmatter.updated = new Date().toISOString();

    if (message.provider && !this.frontmatter.providers.includes(message.provider)) {
      this.frontmatter.providers.push(message.provider);
    }
  }

  setMessageState(index: number, state: MemoryState): void {
    if (index >= 0 && index < this.messages.length) {
      this.messages[index].memoryState = state;
    }
  }

  // ─── Context assembly ─────────────────────────────────────────────────────

  /**
   * Return messages eligible for context injection, respecting memory states
   * and the token budget.
   *
   * Priority order:
   *   1. Core — always included
   *   2. Remembered — included next
   *   3. Default — included in reverse-chronological order until budget exhausted
   *   4. Forgotten — never included
   */
  getContextMessages(budget: TokenBudget): Message[] {
    const estimator = new ContextBuilder();

    const core = this.messages.filter((m) => m.memoryState === MemoryState.Core);
    const remembered = this.messages.filter((m) => m.memoryState === MemoryState.Remembered);
    const defaults = this.messages.filter((m) => m.memoryState === MemoryState.Default);

    const result: Message[] = [...core, ...remembered];
    let used = result.reduce((sum, m) => sum + estimator.estimateTokens(m.content), 0);

    // Add defaults newest-first until we run out of budget
    for (const msg of [...defaults].reverse()) {
      const tokens = estimator.estimateTokens(msg.content);
      if (used + tokens <= budget.max) {
        result.push(msg);
        used += tokens;
      }
    }

    return result;
  }

  // ─── Serialization ────────────────────────────────────────────────────────

  toMarkdown(): string {
    const fm = yaml.stringify(this.frontmatter, { lineWidth: 0 }).trimEnd();
    const body = this.messages
      .map((m) => {
        if (m.role === 'assistant') {
          const tag = m.model ? ` [${m.model}]` : m.provider ? ` [${m.provider}]` : '';
          return `## Assistant${tag}\n\n${m.content}`;
        }
        if (m.role === 'system') {
          return `## System\n\n${m.content}`;
        }
        return `## User\n\n${m.content}`;
      })
      .join('\n\n');

    return `---\n${fm}\n---\n\n${body}`;
  }

  static fromVaultNote(note: VaultNote): Conversation {
    const frontmatter = note.frontmatter as unknown as ConversationFrontmatter;
    const messages: Message[] = [];

    // Split on headings, keeping the heading text
    const sections = note.content.split(/(?=^## )/m).filter((s) => s.trim());

    for (const section of sections) {
      const newline = section.indexOf('\n');
      if (newline === -1) continue;

      const header = section.slice(0, newline).replace(/^## /, '').trim();
      const content = section.slice(newline + 1).trim();

      let role: Message['role'] = 'user';
      let model: string | undefined;

      if (header.startsWith('Assistant')) {
        role = 'assistant';
        const m = header.match(/\[([^\]]+)\]/);
        if (m) model = m[1];
      } else if (header.toLowerCase() === 'system') {
        role = 'system';
      }

      messages.push({
        role,
        content,
        timestamp: new Date(frontmatter.created ?? Date.now()),
        model,
        memoryState: MemoryState.Default,
      });
    }

    return new Conversation(messages, frontmatter);
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private static defaultFrontmatter(): ConversationFrontmatter {
    const now = new Date().toISOString();
    return {
      type: 'conversation',
      created: now,
      updated: now,
      providers: [],
      tags: [],
      message_count: 0,
    };
  }
}
