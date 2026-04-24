import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  configureClaudeDesktopMcp,
  configureClaudeCodeMcp,
  configureCopilotMcp,
  configureCursorMcp,
  configureVsCodeMcp,
  configureWindsurfMcp,
  configureOpencodeMcp,
  configureZedMcp,
  injectBootstrap,
  writeCopilotInstructions,
  injectWindsurfGlobalRules,
  injectOpencodeGlobalRules,
  getBootstrapFileInfo,
} from './harness-config.js';
import type { PromptSession } from './prompt-helpers.js';
import { ask } from './prompt-helpers.js';
import { configureAgentsSkills } from './harness-skills.js';
import type { InitAnswers } from './types.js';
import { copyTextToClipboard, harnessLine, runManualCursorSetup, runManualZedSetup, section, withSpinner } from './ui.js';
import type { Placement } from './markers.js';

interface HarnessSetupOptions {
  repoRoot: string;
  mcpScriptPath: string;
  answers: InitAnswers;
  prompt: PromptSession;
  verbose?: boolean;
}

interface HarnessTaskResult {
  status: 'ok' | 'manual' | 'skipped' | 'failed';
  summary: string;
}

async function readBootstrapTemplate(repoRoot: string): Promise<string | null> {
  const templatePath = path.join(repoRoot, 'templates', 'engram-bootstrap.tmpl.md');
  return await fs.readFile(templatePath, 'utf8').catch(() => null);
}

async function resolveBootstrapPlacement(
  answers: InitAnswers,
): Promise<Placement> {
  if (!(answers.harnesses.claudeCode && answers.claudeCodeScope === 'user')) {
    return answers.bootstrapPlacement;
  }

  const info = await getBootstrapFileInfo();
  if (!info.exists || info.hasMarkers) return answers.bootstrapPlacement;

  // Placement was already chosen during init questions; do not prompt again here.
  return answers.bootstrapPlacement;
}

async function setupClaudeDesktop(mcpScriptPath: string): Promise<HarnessTaskResult> {
  const configPath = await configureClaudeDesktopMcp(mcpScriptPath);
  return { status: 'ok', summary: `MCP configured (${configPath})` };
}

function setupClaudeCode(mcpScriptPath: string, scope: 'local' | 'user'): HarnessTaskResult {
  const result = configureClaudeCodeMcp(mcpScriptPath, scope);
  if (result.kind === 'configured') {
    return { status: 'ok', summary: `MCP configured (${scope} scope)` };
  }
  if (result.kind === 'missing_cli') {
    return { status: 'failed', summary: 'Claude CLI not found on PATH' };
  }
  return { status: 'failed', summary: result.detail ?? 'Claude CLI MCP add failed' };
}

async function setupCursor(
  mcpScriptPath: string,
): Promise<HarnessTaskResult> {
  const configPath = await configureCursorMcp(mcpScriptPath);
  return { status: 'ok', summary: `MCP configured (${configPath})` };
}

async function runCursorManualSetup(
  bootstrapTemplate: string | null,
  prompt: PromptSession,
): Promise<HarnessTaskResult> {
  if (bootstrapTemplate === null) {
    return { status: 'skipped', summary: 'bootstrap template missing' };
  }

  await runManualCursorSetup({
    copyBootstrap: () => copyTextToClipboard(bootstrapTemplate),
    waitForCopyPrompt: async () => {
      await ask(prompt, 'Press Enter to copy Engram bootstrap instructions for Cursor', '');
    },
    waitForContinue: async () => {
      await ask(prompt, 'After pasting the bootstrap into Cursor UI, press Enter to continue', '');
    },
  });

  return { status: 'manual', summary: 'manual rule paste completed' };
}

async function setupVsCode(mcpScriptPath: string): Promise<HarnessTaskResult> {
  const configPath = await configureVsCodeMcp(mcpScriptPath);
  return { status: 'ok', summary: `MCP configured (${configPath})` };
}

async function setupZed(
  mcpScriptPath: string,
): Promise<HarnessTaskResult> {
  const configPath = await configureZedMcp(mcpScriptPath);
  return { status: 'ok', summary: `MCP configured (${configPath})` };
}

async function runZedManualSetup(
  bootstrapTemplate: string | null,
  prompt: PromptSession,
): Promise<HarnessTaskResult> {
  if (bootstrapTemplate === null) {
    return { status: 'skipped', summary: 'bootstrap template missing' };
  }

  await runManualZedSetup({
    copyBootstrap: () => copyTextToClipboard(bootstrapTemplate),
    waitForCopyPrompt: async () => {
      await ask(prompt, 'Press Enter to copy Engram bootstrap instructions for Zed', '');
    },
    waitForContinue: async () => {
      await ask(prompt, 'After pasting the bootstrap into Zed UI, press Enter to continue', '');
    },
  });

  return { status: 'manual', summary: 'manual rule paste completed' };
}

async function setupCopilot(mcpScriptPath: string, bootstrapTemplate: string | null): Promise<HarnessTaskResult> {
  const mcpPath = await configureCopilotMcp(mcpScriptPath);
  if (bootstrapTemplate === null) {
    return { status: 'ok', summary: `MCP configured (${mcpPath}); bootstrap template missing` };
  }
  const instrPath = await writeCopilotInstructions(bootstrapTemplate);
  return { status: 'ok', summary: `MCP + bootstrap configured (${mcpPath}, ${instrPath})` };
}

async function setupWindsurf(mcpScriptPath: string, bootstrapTemplate: string | null): Promise<HarnessTaskResult> {
  const mcpPath = await configureWindsurfMcp(mcpScriptPath);
  if (bootstrapTemplate === null) {
    return { status: 'ok', summary: `MCP configured (${mcpPath}); bootstrap template missing` };
  }
  const rules = await injectWindsurfGlobalRules(bootstrapTemplate);
  return { status: 'ok', summary: `MCP + bootstrap configured (${mcpPath}, ${rules.path})` };
}

async function setupOpenCode(mcpScriptPath: string, bootstrapTemplate: string | null): Promise<HarnessTaskResult> {
  const mcpPath = await configureOpencodeMcp(mcpScriptPath);
  if (bootstrapTemplate === null) {
    return { status: 'ok', summary: `MCP configured (${mcpPath}); bootstrap template missing` };
  }
  const rules = await injectOpencodeGlobalRules(bootstrapTemplate);
  return { status: 'ok', summary: `MCP + bootstrap configured (${mcpPath}, ${rules.path})` };
}

async function setupAgentsSkills(repoRoot: string): Promise<HarnessTaskResult> {
  const skillsSourceDir = path.join(repoRoot, 'templates', 'skills');
  const actions = await configureAgentsSkills(skillsSourceDir);
  const installed = actions.filter((entry) => entry.startsWith('installed '));
  const { length: installedCount } = installed;
  if (installedCount > 0) {
    return { status: 'ok', summary: `Installed ${installedCount} skill bundle(s)` };
  }
  return { status: 'skipped', summary: actions.join('; ') };
}

async function setupClaudeCodeBootstrap(
  template: string | null,
  placement: Placement,
): Promise<HarnessTaskResult> {
  if (template === null) {
    return { status: 'skipped', summary: 'Bootstrap template missing' };
  }
  const result = await injectBootstrap(template, placement);
  return { status: 'ok', summary: `Bootstrap ${result.action} (${result.path})` };
}

async function runHarnessTask(
  label: string,
  task: () => Promise<HarnessTaskResult>,
): Promise<HarnessTaskResult> {
  try {
    return await withSpinner(`Configuring ${label}...`, async () => await task());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'failed', summary: message };
  }
}

export async function runHarnessSetupStage(options: HarnessSetupOptions): Promise<void> {
  const { repoRoot, mcpScriptPath, answers, prompt, verbose = false } = options;

  section('Harness setup');
  const bootstrapTemplate = await readBootstrapTemplate(repoRoot);
  const claudeBootstrapPlacement = await resolveBootstrapPlacement(answers);

  await maybeRunClaudeCodeSetup({
    enabled: answers.harnesses.claudeCode,
    mcpScriptPath,
    scope: answers.claudeCodeScope,
    bootstrapTemplate,
    bootstrapPlacement: claudeBootstrapPlacement,
    verbose,
  });

  await maybeRunSimpleHarness({
    enabled: answers.harnesses.claudeDesktop,
    label: 'Claude Desktop',
    verbose,
    run: async () => await setupClaudeDesktop(mcpScriptPath),
  });

  await maybeRunCursorSetup({
    enabled: answers.harnesses.cursor,
    mcpScriptPath,
    bootstrapTemplate,
    prompt,
    verbose,
  });

  await maybeRunSimpleHarness({
    enabled: answers.harnesses.vscode,
    label: 'VS Code',
    verbose,
    run: async () => await setupVsCode(mcpScriptPath),
  });

  await maybeRunZedSetup({
    enabled: answers.harnesses.zed,
    mcpScriptPath,
    bootstrapTemplate,
    prompt,
    verbose,
  });

  await maybeRunSimpleHarness({
    enabled: answers.harnesses.copilot,
    label: 'GitHub Copilot',
    verbose,
    run: async () => await setupCopilot(mcpScriptPath, bootstrapTemplate),
  });

  await maybeRunSimpleHarness({
    enabled: answers.harnesses.windsurf,
    label: 'Windsurf',
    verbose,
    run: async () => await setupWindsurf(mcpScriptPath, bootstrapTemplate),
  });

  await maybeRunSimpleHarness({
    enabled: answers.harnesses.opencode,
    label: 'OpenCode',
    verbose,
    run: async () => await setupOpenCode(mcpScriptPath, bootstrapTemplate),
  });

  await maybeRunSimpleHarness({
    enabled: answers.harnesses.agentsSkills,
    label: 'Agent Skills',
    verbose,
    run: async () => await setupAgentsSkills(repoRoot),
  });
}

interface SimpleHarnessRunOptions {
  enabled: boolean;
  label: string;
  verbose: boolean;
  run: () => Promise<HarnessTaskResult>;
}

async function maybeRunSimpleHarness(options: SimpleHarnessRunOptions): Promise<void> {
  const { enabled, label, verbose, run } = options;
  if (!enabled) return;

  const result = await runHarnessTask(label, run);
  harnessLine({
    status: result.status,
    label,
    summary: verbose ? result.summary : undefined,
  });
}

interface ClaudeCodeSetupOptions {
  enabled: boolean;
  mcpScriptPath: string;
  scope: 'local' | 'user';
  bootstrapTemplate: string | null;
  bootstrapPlacement: Placement;
  verbose: boolean;
}

async function maybeRunClaudeCodeSetup(options: ClaudeCodeSetupOptions): Promise<void> {
  const { enabled, mcpScriptPath, scope, bootstrapTemplate, bootstrapPlacement, verbose } = options;
  if (!enabled) return;

  const result = await runHarnessTask('Claude Code', async () => {
    const mcp = setupClaudeCode(mcpScriptPath, scope);
    if (mcp.status === 'failed') return mcp;
    if (scope !== 'user') return mcp;

    const bootstrap = await setupClaudeCodeBootstrap(bootstrapTemplate, bootstrapPlacement);
    if (bootstrap.status === 'failed') return bootstrap;

    return {
      status: 'ok',
      summary: `${mcp.summary}; ${bootstrap.summary}`,
    };
  });

  harnessLine({
    status: result.status,
    label: 'Claude Code',
    summary: verbose ? result.summary : undefined,
  });
}

interface ManualHarnessSetupOptions {
  enabled: boolean;
  label: string;
  manualLabel: string;
  mcpScriptPath: string;
  bootstrapTemplate: string | null;
  prompt: PromptSession;
  verbose: boolean;
  setup: (mcpScriptPath: string) => Promise<HarnessTaskResult>;
  setupManual: (bootstrapTemplate: string | null, prompt: PromptSession) => Promise<HarnessTaskResult>;
}

async function maybeRunManualHarnessSetup(options: ManualHarnessSetupOptions): Promise<void> {
  const {
    enabled,
    label,
    manualLabel,
    mcpScriptPath,
    bootstrapTemplate,
    prompt,
    verbose,
    setup,
    setupManual,
  } = options;
  if (!enabled) return;

  const result = await runHarnessTask(label, async () => await setup(mcpScriptPath));
  harnessLine({
    status: result.status,
    label,
    summary: verbose ? result.summary : undefined,
  });

  if (result.status === 'failed') return;

  const manualResult = await setupManual(bootstrapTemplate, prompt);
  harnessLine({
    status: manualResult.status,
    label: manualLabel,
    summary: verbose ? manualResult.summary : undefined,
  });
}

interface CursorSetupOptions {
  enabled: boolean;
  mcpScriptPath: string;
  bootstrapTemplate: string | null;
  prompt: PromptSession;
  verbose: boolean;
}

async function maybeRunCursorSetup(options: CursorSetupOptions): Promise<void> {
  await maybeRunManualHarnessSetup({
    enabled: options.enabled,
    label: 'Cursor',
    manualLabel: 'Cursor (manual)',
    mcpScriptPath: options.mcpScriptPath,
    bootstrapTemplate: options.bootstrapTemplate,
    prompt: options.prompt,
    verbose: options.verbose,
    setup: async (mcpScriptPath) => await setupCursor(mcpScriptPath),
    setupManual: async (bootstrapTemplate, prompt) => await runCursorManualSetup(bootstrapTemplate, prompt),
  });
}

interface ZedSetupOptions {
  enabled: boolean;
  mcpScriptPath: string;
  bootstrapTemplate: string | null;
  prompt: PromptSession;
  verbose: boolean;
}

async function maybeRunZedSetup(options: ZedSetupOptions): Promise<void> {
  await maybeRunManualHarnessSetup({
    enabled: options.enabled,
    label: 'Zed',
    manualLabel: 'Zed (manual)',
    mcpScriptPath: options.mcpScriptPath,
    bootstrapTemplate: options.bootstrapTemplate,
    prompt: options.prompt,
    verbose: options.verbose,
    setup: async (mcpScriptPath) => await setupZed(mcpScriptPath),
    setupManual: async (bootstrapTemplate, prompt) => await runZedManualSetup(bootstrapTemplate, prompt),
  });
}
