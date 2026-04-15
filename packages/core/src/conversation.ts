import * as yaml from 'yaml';
import { MemoryState } from './types';
import type { Message, ChatMessage, TokenBudget, PruneOptions, ConversationFrontmatter } from './types';
import type { VaultNote } from './vault';
import { ContextBuilder } from './context';
import { pruneMessages } from './prune';

export class Conversation {
  constructor(
    public messages: Message[] = [],
    public frontmatter: ConversationFrontmatter = Conversation.defaultFrontmatter(),
  ) {}

  // ─── Mutation ─────────────────────────────────────────────────────────────

  addMessage(message: Message): void {
    const { messages, frontmatter } = this;
    messages.push(message);
    const { length: messageCount } = messages;
    frontmatter.message_count = messageCount;
    frontmatter.updated = new Date().toISOString();

    if (
      message.provider !== undefined &&
      message.provider.length > 0 &&
      !frontmatter.providers.includes(message.provider)
    ) {
      frontmatter.providers.push(message.provider);
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

  /**
   * Return a provider-agnostic ChatMessage[] ready to send to any chat
   * completion API.  Delegates to the standalone `pruneMessages()` function
   * so the same pruning logic is available with or without a Conversation
   * instance.
   */
  toChatMessages(options: PruneOptions = {}): ChatMessage[] {
    return pruneMessages(this.messages, options);
  }

  // ─── Serialization ────────────────────────────────────────────────────────

  toMarkdown(): string {
    const fm = yaml.stringify(this.frontmatter, { lineWidth: 0 }).trimEnd();
    const body = this.messages
      .map((m) => {
        if (m.role === 'assistant') {
          const tag = m.model !== undefined && m.model.length > 0
            ? ` [${m.model}]`
            : m.provider !== undefined && m.provider.length > 0
              ? ` [${m.provider}]`
              : '';
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
    const frontmatter: ConversationFrontmatter = {
      ...Conversation.defaultFrontmatter(),
      ...note.frontmatter,
      type: 'conversation',
      providers: Array.isArray(note.frontmatter.providers)
        ? note.frontmatter.providers.filter(
          (provider): provider is string => typeof provider === 'string' && provider.length > 0,
        )
        : [],
      message_count:
        typeof note.frontmatter.message_count === 'number' ? note.frontmatter.message_count : 0,
    };
    const messages: Message[] = [];

    // Split on headings, keeping the heading text
    const sections = note.content
      .split(/(?=^## )/mu)
      .filter((section) => section.trim().length > 0);

    for (const section of sections) {
      const newline = section.indexOf('\n');
      if (newline === -1) continue;

      const header = section.slice(0, newline).replace(/^## /u, '').trim();
      const content = section.slice(newline + 1).trim();

      let role: Message['role'] = 'user';
      let model: string | undefined = undefined;

      if (header.startsWith('Assistant')) {
        role = 'assistant';
        const modelMatch = /\[(?<model>[^\]]+)\]/u.exec(header);
        if (modelMatch !== null) {
          const [, capturedModel] = modelMatch;
          model = capturedModel;
        }
      } else if (header.toLowerCase() === 'system') {
        role = 'system';
      }

      messages.push({
        role,
        content,
        timestamp: new Date(frontmatter.created),
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
