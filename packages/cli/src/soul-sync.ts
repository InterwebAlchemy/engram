import type * as readline from 'node:readline/promises';

import { prepareSoulDocumentPlan, writeSoulDocument } from './soul-document';
import { isChoice } from './utils';
import type { InitAnswers } from './types';

function writeLine(message = ''): void {
  process.stdout.write(`${message}\n`);
}

async function askChoice<T extends string>(
  rl: readline.Interface,
  label: string,
  options: readonly T[],
  defaultValue: T,
): Promise<T> {
  const defaultSuffix = defaultValue.length > 0 ? ` (${defaultValue})` : '';
  const answer = (await rl.question(`${label} [${options.join('/')}]${defaultSuffix}: `)).trim().toLowerCase();
  if (answer.length === 0) return defaultValue;
  return isChoice(options, answer) ? answer : await askChoice(rl, label, options, defaultValue);
}

export async function syncSoulDocument(
  templatePath: string,
  answers: InitAnswers,
  rl: readline.Interface,
): Promise<void> {
  const plan = await prepareSoulDocumentPlan(templatePath, answers);

  if (plan.existingContent === null) {
    await writeSoulDocument(plan, 'replace');
    writeLine(`Soul → ${plan.soulPath} (created)`);
    return;
  }

  writeLine();
  writeLine(`Existing Soul detected at ${plan.soulPath}.`);
  writeLine('The CLI will preserve editable sections by default instead of regenerating the whole file.');
  if (plan.gitIdentityChanged) {
    writeLine('Config git identity differs from the current Soul frontmatter and can be synced automatically.');
  }
  if (plan.coreDiffHeadings.length > 0) {
    writeLine('Core Engram sections that differ from the current template:');
    for (const heading of plan.coreDiffHeadings) {
      writeLine(`- ${heading}`);
    }
  } else {
    writeLine('Core Engram sections already match the current template.');
  }

  const mode = await askChoice(rl, 'Soul update mode', ['preserve', 'core', 'replace'] as const, 'preserve');
  const action = await writeSoulDocument(plan, mode === 'core' || mode === 'replace' ? mode : 'preserve');

  switch (action) {
    case 'created':
      writeLine(`Soul → ${plan.soulPath} (created)`);
      break;
    case 'preserved':
      writeLine(`Soul → ${plan.soulPath} (preserved existing content; synced safe metadata only)`);
      break;
    case 'updated_core':
      writeLine(`Soul → ${plan.soulPath} (updated core Engram sections; preserved editable sections)`);
      break;
    case 'replaced':
      writeLine(`Soul → ${plan.soulPath} (replaced from template)`);
      break;
  }
}
