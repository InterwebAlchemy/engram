import type { ScratchEntry } from '@interwebalchemy/engram-core';
import type EngramPlugin from '../main';

const BOOTSTRAP_SCRATCH_MAX_CHARS = 400;
const COMPACTED_PREFIX = '[COMPACTED] ';
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = MS_PER_MINUTE * MINUTES_PER_HOUR;
const MS_PER_DAY = MS_PER_HOUR * HOURS_PER_DAY;

export interface EngramBootstrap {
  readonly content: string;
  readonly threadId: string | undefined;
}

/**
 * Engram-native session bootstrap. Runs soul → thread resolve → inbox → scratch
 * so the chat model starts with the same context a tool-calling Fragment would
 * reconstruct via the MCP bootstrap chain.
 */
export async function buildEngramBootstrap(plugin: EngramPlugin): Promise<EngramBootstrap> {
  const parts: string[] = [];
  const soulPart = await loadSoulPart(plugin);
  if (soulPart !== null) {
    parts.push(soulPart);
  }

  const resolved = await resolveThreadSafely(plugin);
  const threadId = resolved?.threadId;
  if (resolved !== null) {
    parts.push(resolved.section);
  }

  const inboxPart = await loadInboxPart(plugin, threadId);
  if (inboxPart !== null) {
    parts.push(inboxPart);
  }

  const scratchPart = await loadScratchPart(plugin);
  if (scratchPart !== null) {
    parts.push(scratchPart);
  }

  return {
    content: parts.join('\n\n'),
    threadId,
  };
}

async function loadSoulPart(plugin: EngramPlugin): Promise<string | null> {
  try {
    const soul = await plugin.memoryManager.getSoulDocument();
    const body = soul?.content.trim() ?? '';
    return body.length === 0 ? null : `## Soul\n\n${body}`;
  } catch {
    return null;
  }
}

interface ResolvedThreadSection {
  readonly threadId: string;
  readonly section: string;
}

async function resolveThreadSafely(plugin: EngramPlugin): Promise<ResolvedThreadSection | null> {
  try {
    const cwd = plugin.getVaultBasePath();
    const { threadId, thread } = await plugin.memoryManager.resolveThread({
      cwd: cwd.length === 0 ? undefined : cwd,
      autoCreate: false,
    });
    const { frontmatter, content } = thread;
    const { name: rawName } = frontmatter;
    const threadName = typeof rawName === 'string' && rawName.length > 0
      ? rawName
      : threadId;
    const body = content.trim();
    const section = body.length === 0
      ? `## Thread: ${threadName}`
      : `## Thread: ${threadName}\n\n${body}`;
    return { threadId, section };
  } catch {
    return null;
  }
}

async function loadInboxPart(plugin: EngramPlugin, threadId: string | undefined): Promise<string | null> {
  const sections: string[] = [];
  try {
    const global = await plugin.memoryManager.getGlobalInboxSummary(threadId);
    if (global !== null && global.length > 0) {
      sections.push(global);
    }
  } catch {
    // ignore
  }

  if (threadId !== undefined) {
    try {
      const threadInbox = await plugin.memoryManager.getThreadInboxSummary(threadId);
      if (threadInbox !== null && threadInbox.length > 0) {
        sections.push(threadInbox);
      }
    } catch {
      // ignore
    }
  }

  return sections.length === 0 ? null : `## Inbox\n\n${sections.join('\n\n')}`;
}

async function loadScratchPart(plugin: EngramPlugin): Promise<string | null> {
  try {
    const entries = await plugin.memoryManager.readScratch({ bootstrap: true });
    if (entries.length === 0) {
      return null;
    }
    const now = Date.now();
    const lines = entries.map((entry) => formatBootstrapScratchEntry(entry, now));
    return `## Recent Activity\n\n${lines.join('\n')}`;
  } catch {
    return null;
  }
}

function formatBootstrapScratchEntry(entry: ScratchEntry, now: number): string {
  const ageMs = now - new Date(entry.timestamp).getTime();
  const content = entry.content.startsWith(COMPACTED_PREFIX)
    ? entry.content.slice(COMPACTED_PREFIX.length)
    : entry.content;
  const truncated = content.length > BOOTSTRAP_SCRATCH_MAX_CHARS
    ? `${content.slice(0, BOOTSTRAP_SCRATCH_MAX_CHARS)}…`
    : content;
  return `- [${formatRelativeAge(ageMs)}] ${truncated}`;
}

function formatRelativeAge(ageMs: number): string {
  if (ageMs >= MS_PER_DAY) {
    return `${Math.floor(ageMs / MS_PER_DAY)}d ago`;
  }
  if (ageMs >= MS_PER_HOUR) {
    return `${Math.floor(ageMs / MS_PER_HOUR)}h ago`;
  }
  return `${Math.max(0, Math.floor(ageMs / MS_PER_MINUTE))}m ago`;
}
