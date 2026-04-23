/**
 * Claude Code MCP removal — uses the `claude` CLI to remove the engram server.
 */

import { once } from 'node:events';
import { spawn } from 'node:child_process';

import type { HarnessRemovalResult } from './harness-config';

export async function removeClaudeCodeMcp(): Promise<HarnessRemovalResult> {
  try {
    const child = spawn('claude', ['mcp', 'remove', 'engram'], { stdio: 'pipe' });
    const exitPromise = once(child, 'exit');
    const errorPromise = once(child, 'error').then(([err]: unknown[]) => {
      throw err instanceof Error ? err : new Error(String(err));
    });
    const exitResult: unknown = await Promise.race([exitPromise, errorPromise]);
    if (!Array.isArray(exitResult)) {
      return { harness: 'Claude Code', action: 'error', detail: 'unexpected exit result' };
    }
    const code: unknown = exitResult.at(0);
    if (code === 0) {
      return { harness: 'Claude Code', action: 'removed', detail: 'ran claude mcp remove engram' };
    }
    const codeStr = typeof code === 'number' ? String(code) : 'unknown';
    return { harness: 'Claude Code', action: 'error', detail: `claude mcp remove exited with code ${codeStr}` };
  } catch {
    return { harness: 'Claude Code', action: 'error', detail: 'claude CLI not found or failed' };
  }
}
