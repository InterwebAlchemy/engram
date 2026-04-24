import * as fs from 'node:fs/promises';

import { isEnvKey, quoteForShell } from './utils.js';
import type { HarnessOption, InitAnswers } from './types.js';

const TRUE_VALUE = 'true';
const FALSE_VALUE = 'false';
const ENV_SEPARATOR = '=';
const NEWLINE_PATTERN = /\r?\n/gu;

export function buildEnvUpdates(
  answers: InitAnswers,
  harnesses: HarnessOption[],
): Record<string, string> {
  const gitIdentity = answers.gitName.trim().length > 0 && answers.gitEmail.trim().length > 0
    ? `${answers.gitName.trim()} <${answers.gitEmail.trim()}>`
    : '';
  const updates: Record<string, string> = {
    ENGRAM_NAME: answers.agentName,
    ENGRAM_VAULT_PATH: answers.vaultPath,
    ENGRAM_ROOT: answers.engramRoot,
    ENGRAM_VOICE_PRESET: answers.voicePreset,
    GIT_IDENTITY: gitIdentity,
    ENGRAM_GIT_IDENTITY: gitIdentity,
    MCP_CLAUDE_CODE_SCOPE: answers.claudeCodeScope,
  };
  for (const harness of harnesses) {
    updates[harness.envKey] = answers.harnesses[harness.key] ? TRUE_VALUE : FALSE_VALUE;
  }
  return updates;
}

export async function upsertEnvFile(
  envPath: string,
  updates: Record<string, string>,
): Promise<void> {
  const existing = await fs.readFile(envPath, 'utf8').catch(() => '');
  const lines = existing.length > 0 ? existing.split(NEWLINE_PATTERN) : [];
  const pending = new Map(Object.entries(updates));
  const nextLines = lines.map((line: string) => {
    const idx = line.indexOf(ENV_SEPARATOR);
    if (idx === -1) return line;
    const key = line.slice(0, idx);
    if (!isEnvKey(key) || !pending.has(key)) return line;
    const value = pending.get(key) ?? '';
    pending.delete(key);
    return `${key}=${quoteForShell(value)}`;
  });

  if (nextLines.length > 0 && nextLines[nextLines.length - 1] !== '') nextLines.push('');
  for (const [key, value] of pending) nextLines.push(`${key}=${quoteForShell(value)}`);

  const content = `${nextLines.join('\n').replace(/\n{3,}/gu, '\n\n').trimEnd()}\n`;
  await fs.writeFile(envPath, content, 'utf8');
}
