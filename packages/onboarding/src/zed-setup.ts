import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { configureZedMcp } from './harness-config.js';
import { ask, type PromptSession } from './prompt-helpers.js';
import type { InitAnswers } from './types.js';
import { copyTextToClipboard, runManualZedSetup, section, skipped, status } from './ui.js';

export async function runZedSetupStage(options: {
  repoRoot: string;
  mcpScriptPath: string;
  answers: InitAnswers;
  prompt: PromptSession;
}): Promise<void> {
  const {
    repoRoot,
    mcpScriptPath,
    answers,
    prompt,
  } = options;

  if (!answers.harnesses.zed) {
    return;
  }

  section('Zed setup');
  const mcpPath = await configureZedMcp(mcpScriptPath);
  status('MCP config', mcpPath);

  const agentsTemplatePath = path.join(repoRoot, 'templates', 'engram-bootstrap.tmpl.md');
  const agentsTemplate = await fs.readFile(agentsTemplatePath, 'utf8').catch(() => null);
  if (agentsTemplate === null) {
    skipped('Zed bootstrap', 'templates/engram-bootstrap.tmpl.md not found');
    return;
  }

  await runManualZedSetup({
    copyBootstrap: () => copyTextToClipboard(agentsTemplate),
    waitForCopyPrompt: async () => {
      await ask(prompt, 'Press Enter to copy Engram bootstrap instructions for Zed', '');
    },
    waitForContinue: async () => {
      await ask(prompt, 'After pasting the bootstrap into Zed UI, press Enter to continue', '');
    },
  });
}