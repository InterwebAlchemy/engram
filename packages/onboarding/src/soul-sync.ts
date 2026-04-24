import { askChoice, type PromptSession } from './prompt-helpers.js';
import { prepareSoulDocumentPlan, writeSoulDocument } from './soul-document.js';
import { bullet, note, status, subheading } from './ui.js';
import type { InitAnswers } from './types.js';

function hasEditableContentDifferences(plan: {
  coreDiffHeadings: string[];
  gitIdentityChanged: boolean;
}): boolean {
  return plan.coreDiffHeadings.length > 0 || plan.gitIdentityChanged;
}

export async function syncSoulDocument(
  templatePath: string,
  answers: InitAnswers,
  prompt: PromptSession,
): Promise<void> {
  const plan = await prepareSoulDocumentPlan(templatePath, answers);

  if (plan.existingContent === null) {
    await writeSoulDocument(plan, 'replace');
    status('Soul', plan.soulPath, 'created');
    return;
  }

  subheading(`Existing Soul detected at ${plan.soulPath}.`);
  note('The CLI will preserve editable sections by default instead of regenerating the whole file.');
  if (plan.gitIdentityChanged) {
    note('Config git identity differs from the current Soul frontmatter and can be synced automatically.');
  }
  if (plan.coreDiffHeadings.length > 0) {
    note('Core Engram sections that differ from the current template:');
    for (const heading of plan.coreDiffHeadings) {
      bullet(heading);
    }
  } else {
    note('Core Engram sections already match the current template.');
  }

  let selectedMode: 'preserve' | 'core' | 'replace' = 'preserve';

  if (hasEditableContentDifferences(plan)) {
    note('Choose how to apply template updates:');
    bullet('safe (recommended): keep your current Soul text and only sync safe metadata (for example, git_identity).');
    bullet('refresh core: update core Engram sections to the current template while preserving your editable/custom sections.');
    bullet('replace all: overwrite the Soul file from template (destructive to custom edits).');
    selectedMode = await askChoice(
      prompt,
      'Soul update mode',
      ['safe', 'refresh core', 'replace all'] as const,
      'safe',
    ).then((mode) => {
      if (mode === 'refresh core') return 'core';
      if (mode === 'replace all') return 'replace';
      return 'preserve';
    });
  } else {
    note('No core template drift detected. Keeping your existing Soul content and syncing safe metadata.');
  }

  const action = await writeSoulDocument(plan, selectedMode);

  switch (action) {
    case 'created':
      status('Soul', plan.soulPath, 'created');
      break;
    case 'preserved':
      status('Soul', plan.soulPath, 'preserved existing content; synced safe metadata only');
      break;
    case 'updated_core':
      status('Soul', plan.soulPath, 'updated core sections; preserved editable sections');
      break;
    case 'replaced':
      status('Soul', plan.soulPath, 'replaced from template');
      break;
  }
}
