/**
 * Harness MCP config manipulation — read, inject, and remove the `engram`
 * server entry from JSON config files used by various harnesses.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { env, platform } from 'node:process';

import { stripMarkedBlock, injectMarkedBlock, hasMarkedBlock, isOnlyMarkedBlock, type Placement } from './markers';

const JSON_INDENT = 2;

// ── Platform paths ──────────────────────────────────────────────────────────

function homeDir(): string {
  return env.HOME ?? '';
}

function claudeDesktopConfigPath(): string {
  return platform === 'darwin'
    ? path.join(homeDir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : path.join(homeDir(), '.config', 'Claude', 'claude_desktop_config.json');
}

function vsCodeMcpPath(): string {
  return platform === 'darwin'
    ? path.join(homeDir(), 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
    : path.join(homeDir(), '.config', 'Code', 'User', 'mcp.json');
}

function cursorMcpPath(): string {
  return path.join(homeDir(), '.cursor', 'mcp.json');
}

function copilotMcpPath(): string {
  return path.join(homeDir(), '.copilot', 'mcp-config.json');
}

function copilotInstructionsPath(): string {
  return path.join(homeDir(), '.copilot', 'instructions', 'engram.instructions.md');
}

function windsurfMcpPath(): string {
  return path.join(homeDir(), '.codeium', 'windsurf', 'mcp_config.json');
}

function claudeCodeBootstrapPath(): string {
  return path.join(homeDir(), '.claude', 'CLAUDE.md');
}

// ── JSON config helpers ─────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJsonFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(data, null, JSON_INDENT)}\n`, 'utf8');
}

function getSection(cfg: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const { [key]: section } = cfg;
  return isRecord(section) ? section : null;
}

function hasEngramKey(cfg: Record<string, unknown>, key: string): boolean {
  const section = getSection(cfg, key);
  return section !== null && 'engram' in section;
}

function removeEngramKey(cfg: Record<string, unknown>, key: string): Record<string, unknown> {
  const section = getSection(cfg, key);
  if (section === null) return cfg;
  const { engram: _, ...rest } = section;
  return { ...cfg, [key]: rest };
}

// ── Markdown file helpers ───────────────────────────────────────────────────

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// ── Public types ────────────────────────────────────────────────────────────

export interface HarnessRemovalResult {
  harness: string;
  action: 'removed' | 'not_found' | 'skipped' | 'error';
  detail: string;
}

export interface BootstrapFileInfo {
  path: string;
  exists: boolean;
  hasMarkers: boolean;
  isOnlyEngram: boolean;
}

// ── MCP config removal ─────────────────────────────────────────────────────

export async function removeClaudeDesktopMcp(): Promise<HarnessRemovalResult> {
  return await removeFromJsonConfig('Claude Desktop', claudeDesktopConfigPath(), 'mcpServers');
}

export async function removeCursorMcp(): Promise<HarnessRemovalResult> {
  return await removeFromJsonConfig('Cursor', cursorMcpPath(), 'mcpServers');
}

export async function removeVsCodeMcp(): Promise<HarnessRemovalResult> {
  return await removeFromJsonConfig('VS Code', vsCodeMcpPath(), 'servers');
}

export async function removeCopilotMcp(): Promise<HarnessRemovalResult> {
  const configResult = await removeFromJsonConfig('GitHub Copilot', copilotMcpPath(), 'mcpServers');
  const instrPath = copilotInstructionsPath();
  try {
    if (await fileExists(instrPath)) {
      await fs.unlink(instrPath);
      configResult.detail = `${configResult.detail}; removed instructions file`;
    }
  } catch (err) {
    configResult.detail = `${configResult.detail}; failed to remove instructions: ${String(err)}`;
  }
  return configResult;
}

export async function removeWindsurfMcp(): Promise<HarnessRemovalResult> {
  return await removeFromJsonConfig('Windsurf', windsurfMcpPath(), 'mcpServers');
}

async function removeFromJsonConfig(
  harness: string,
  configPath: string,
  key: string,
): Promise<HarnessRemovalResult> {
  try {
    if (!(await fileExists(configPath))) {
      return { harness, action: 'not_found', detail: `${configPath} does not exist` };
    }
    const cfg = await readJsonFile(configPath);
    if (!hasEngramKey(cfg, key)) {
      return { harness, action: 'not_found', detail: `no engram entry in ${key}` };
    }
    const updated = removeEngramKey(cfg, key);
    await writeJsonFile(configPath, updated);
    return { harness, action: 'removed', detail: `removed engram from ${configPath}` };
  } catch (err) {
    return { harness, action: 'error', detail: String(err) };
  }
}

// ── Bootstrap file operations ───────────────────────────────────────────────

export async function getBootstrapFileInfo(): Promise<BootstrapFileInfo> {
  const filePath = claudeCodeBootstrapPath();
  const content = await readTextFile(filePath);
  if (content === null) {
    return { path: filePath, exists: false, hasMarkers: false, isOnlyEngram: false };
  }
  return {
    path: filePath,
    exists: true,
    hasMarkers: hasMarkedBlock(content),
    isOnlyEngram: isOnlyMarkedBlock(content),
  };
}

export async function injectBootstrap(
  body: string,
  placement: Placement,
): Promise<{ path: string; action: 'created' | 'injected' | 'updated' }> {
  const filePath = claudeCodeBootstrapPath();
  const existing = (await readTextFile(filePath)) ?? '';
  const result = injectMarkedBlock(existing, body, placement);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, result, 'utf8');

  if (existing.trim().length === 0) return { path: filePath, action: 'created' };
  if (hasMarkedBlock(existing)) return { path: filePath, action: 'updated' };
  return { path: filePath, action: 'injected' };
}

export async function removeBootstrap(): Promise<{
  path: string;
  action: 'stripped' | 'deleted' | 'not_found';
}> {
  const filePath = claudeCodeBootstrapPath();
  const content = await readTextFile(filePath);
  if (content === null || !hasMarkedBlock(content)) {
    return { path: filePath, action: 'not_found' };
  }
  if (isOnlyMarkedBlock(content)) {
    await fs.unlink(filePath);
    return { path: filePath, action: 'deleted' };
  }
  const cleaned = stripMarkedBlock(content);
  await fs.writeFile(filePath, cleaned, 'utf8');
  return { path: filePath, action: 'stripped' };
}

// ── MCP config injection ───────────────────────────────────────────────────

async function injectMcpEntry(
  configPath: string,
  key: string,
  command: string,
): Promise<void> {
  const cfg = await readJsonFile(configPath);
  const section = getSection(cfg, key) ?? {};
  const updated = { ...cfg, [key]: { ...section, engram: { command, args: [] } } };
  await writeJsonFile(configPath, updated);
}

export async function configureWindsurfMcp(command: string): Promise<string> {
  const configPath = windsurfMcpPath();
  await injectMcpEntry(configPath, 'mcpServers', command);
  return configPath;
}

// ── Windsurf global rules ──────────────────────────────────────────────────

function windsurfGlobalRulesPath(): string {
  return path.join(homeDir(), '.codeium', 'windsurf', 'memories', 'global_rules.md');
}

export async function injectWindsurfGlobalRules(
  body: string,
): Promise<{ path: string; action: 'created' | 'injected' | 'updated' }> {
  const filePath = windsurfGlobalRulesPath();
  const existing = (await readTextFile(filePath)) ?? '';
  const result = injectMarkedBlock(existing, body, 'bottom');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, result, 'utf8');

  if (existing.trim().length === 0) return { path: filePath, action: 'created' };
  if (hasMarkedBlock(existing)) return { path: filePath, action: 'updated' };
  return { path: filePath, action: 'injected' };
}

export async function removeWindsurfGlobalRules(): Promise<{
  path: string;
  action: 'stripped' | 'not_found';
}> {
  const filePath = windsurfGlobalRulesPath();
  const content = await readTextFile(filePath);
  if (content === null || !hasMarkedBlock(content)) {
    return { path: filePath, action: 'not_found' };
  }
  // Don't delete the file — Windsurf manages it. Just strip the Engram block.
  const cleaned = isOnlyMarkedBlock(content) ? '' : stripMarkedBlock(content);
  await fs.writeFile(filePath, cleaned, 'utf8');
  return { path: filePath, action: 'stripped' };
}

// ── Copilot instructions ────────────────────────────────────────────────────

export async function writeCopilotInstructions(body: string): Promise<string> {
  const filePath = copilotInstructionsPath();
  const frontmatter = [
    '---',
    'applyTo: "**"',
    'description: "Engram memory continuity bootstrap — loads agent identity and context at session start"',
    '---',
    '',
  ].join('\n');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${frontmatter}${body.trim()}\n`, 'utf8');
  return filePath;
}

// ── Obsidian plugin cleanup ─────────────────────────────────────────────────

export async function removeObsidianPlugin(vaultPath: string): Promise<string[]> {
  const actions: string[] = [];
  const pluginDir = path.join(vaultPath, '.obsidian', 'plugins', 'engram');

  try {
    if (await fileExists(pluginDir)) {
      await fs.rm(pluginDir, { recursive: true });
      actions.push('removed plugin directory');
    }
  } catch (err) {
    actions.push(`failed to remove plugin dir: ${String(err)}`);
  }

  const communityPluginsPath = path.join(vaultPath, '.obsidian', 'community-plugins.json');
  try {
    if (await fileExists(communityPluginsPath)) {
      const raw = await fs.readFile(communityPluginsPath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((p): p is string => typeof p === 'string' && p !== 'engram');
        if (filtered.length < parsed.length) {
          await fs.writeFile(communityPluginsPath, `${JSON.stringify(filtered, null, JSON_INDENT)}\n`, 'utf8');
          actions.push('removed engram from community-plugins.json');
        }
      }
    }
  } catch (err) {
    actions.push(`failed to update community-plugins.json: ${String(err)}`);
  }

  return actions;
}
