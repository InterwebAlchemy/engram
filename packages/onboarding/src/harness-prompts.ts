import type { ExistingConfig, HarnessKey, HarnessOption } from './types.js';
import { askMultiChoice, type PromptSession } from './prompt-helpers.js';

export async function askHarnesses(
  prompt: PromptSession,
  harnessOptions: readonly HarnessOption[],
  existing: ExistingConfig,
): Promise<Record<HarnessKey, boolean>> {
  const selected = await askMultiChoice(
    prompt,
    'Select harnesses to configure',
    harnessOptions.map((harness) => ({
      value: harness.key,
      label: harness.label,
      description: harness.description,
    })),
    harnessOptions.filter((harness) => existing.harnesses[harness.key]).map((harness) => harness.key),
  );
  const selectedSet = new Set(selected);
  return {
    claudeCode: selectedSet.has('claudeCode'),
    claudeDesktop: selectedSet.has('claudeDesktop'),
    cursor: selectedSet.has('cursor'),
    vscode: selectedSet.has('vscode'),
    zed: selectedSet.has('zed'),
    copilot: selectedSet.has('copilot'),
    windsurf: selectedSet.has('windsurf'),
    opencode: selectedSet.has('opencode'),
    agentsSkills: selectedSet.has('agentsSkills'),
  };
}
