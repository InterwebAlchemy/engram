import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { VOICE_PRESETS } from './voice-presets';
import { buildGitIdentity, escapeRegExp, replaceSection } from './utils';
import type { InitAnswers } from './types';

const FRONTMATTER_PATTERN = /^---\n[\s\S]*?\n---\n?/u;
const FRONTMATTER_OPEN = '---\n';
const FRONTMATTER_CLOSE = '---';
const CORE_SECTION_HEADINGS = [
  'On Self-Knowledge',
  'Harness Negotiation',
  'Working Memory',
  'Continuity',
] as const;

export type SoulUpdateMode = 'preserve' | 'core' | 'replace';

export interface SoulDocumentPlan {
  soulPath: string;
  generatedContent: string;
  existingContent: string | null;
  coreDiffHeadings: string[];
  gitIdentityChanged: boolean;
}

export async function prepareSoulDocumentPlan(
  templatePath: string,
  answers: InitAnswers,
): Promise<SoulDocumentPlan> {
  const template = await fs.readFile(templatePath, 'utf8');
  const soulPath = path.join(answers.vaultPath, answers.engramRoot, 'memory', 'soul.md');
  const existingContent = await fs.readFile(soulPath, 'utf8').catch(() => null);
  const generatedContent = buildGeneratedSoulContent(template, answers);
  const gitIdentity = buildGitIdentity(answers.gitName, answers.gitEmail);
  const syncedExisting = existingContent === null ? null : syncGitIdentity(existingContent, gitIdentity);

  return {
    soulPath,
    generatedContent,
    existingContent,
    coreDiffHeadings: syncedExisting === null ? [] : diffCoreSections(syncedExisting, generatedContent),
    gitIdentityChanged: existingContent !== null && syncedExisting !== existingContent,
  };
}

export async function writeSoulDocument(
  plan: SoulDocumentPlan,
  mode: SoulUpdateMode,
): Promise<'created' | 'preserved' | 'updated_core' | 'replaced'> {
  const { generatedContent, existingContent, soulPath } = plan;
  const gitIdentity = extractGitIdentity(generatedContent);
  let nextContent = generatedContent;
  let action: 'created' | 'preserved' | 'updated_core' | 'replaced' = 'created';

  if (existingContent !== null) {
    const syncedExisting = syncGitIdentity(existingContent, gitIdentity);
    switch (mode) {
      case 'preserve':
        nextContent = syncedExisting;
        action = 'preserved';
        break;
      case 'core':
        nextContent = applyCoreSections(syncedExisting, generatedContent);
        action = 'updated_core';
        break;
      case 'replace':
        nextContent = generatedContent;
        action = 'replaced';
        break;
    }
  }

  await fs.mkdir(path.dirname(soulPath), { recursive: true });
  await fs.writeFile(soulPath, nextContent, 'utf8');
  return action;
}

function buildGeneratedSoulContent(template: string, answers: InitAnswers): string {
  const { agentName, gitEmail, gitName, voicePreset } = answers;
  const { [voicePreset]: preset } = VOICE_PRESETS;
  const { bootSignature, howIApproachProblems, howICommunicate, values, voiceGuardrails, voiceprint } = preset;
  const gitIdentity = buildGitIdentity(gitName, gitEmail);

  let content = template.replaceAll('[your agent name]', agentName);
  content = gitIdentity.length > 0
    ? content.replace(/# git_identity: your-agent-name <your-agent@example\.com>/u, `git_identity: ${gitIdentity}`)
    : content;
  content = replaceSection(content, 'How I Approach Problems', howIApproachProblems);
  content = replaceSection(content, 'How I Communicate', howICommunicate);
  content = replaceSection(content, 'Voiceprint', voiceprint);
  content = replaceSection(content, 'Boot Signature', bootSignature);
  content = replaceSection(content, 'Voice Guardrails', voiceGuardrails);
  content = replaceSection(content, 'Values I Want to Hold', values.map((value) => `- ${value}`).join('\n'));
  return content;
}

function diffCoreSections(existing: string, generated: string): string[] {
  return CORE_SECTION_HEADINGS.filter((heading) => {
    const existingBody = normalizeSectionBody(extractSectionBody(existing, heading));
    const generatedBody = normalizeSectionBody(extractSectionBody(generated, heading));
    return existingBody !== generatedBody;
  });
}

function applyCoreSections(existing: string, generated: string): string {
  let next = existing;
  for (const heading of CORE_SECTION_HEADINGS) {
    const generatedBody = extractSectionBody(generated, heading);
    if (generatedBody === null) continue;
    next = upsertSectionBody(next, heading, generatedBody);
  }
  return next;
}

function normalizeSectionBody(value: string | null): string {
  return value?.replace(/\r\n/gu, '\n').trim() ?? '';
}

function extractSectionBody(markdown: string, heading: string): string | null {
  const pattern = new RegExp(
    `^## ${escapeRegExp(heading)}\\n\\n(?<body>[\\s\\S]*?)(?=\\n## |$)`,
    'mu',
  );
  const match = pattern.exec(markdown);
  if (match === null) return null;
  const body = match.groups?.body;
  return body === undefined ? null : body.trimEnd();
}

function upsertSectionBody(markdown: string, heading: string, body: string): string {
  if (extractSectionBody(markdown, heading) !== null) {
    return replaceSection(markdown, heading, body);
  }
  return `${markdown.trimEnd()}\n\n## ${heading}\n\n${body.trim()}\n`;
}

function syncGitIdentity(markdown: string, gitIdentity: string): string {
  const frontmatterMatch = FRONTMATTER_PATTERN.exec(markdown);
  if (frontmatterMatch === null) {
    if (gitIdentity.length === 0) return markdown;
    return `${FRONTMATTER_OPEN}git_identity: ${gitIdentity}\n${FRONTMATTER_CLOSE}\n\n${markdown.trimStart()}`;
  }

  const [frontmatter] = frontmatterMatch;
  const body = markdown.slice(frontmatter.length);
  const updatedFrontmatter = gitIdentity.length > 0
    ? upsertFrontmatterField(frontmatter, 'git_identity', gitIdentity)
    : removeFrontmatterField(frontmatter, 'git_identity');
  return `${updatedFrontmatter}${body}`;
}

function extractGitIdentity(markdown: string): string {
  const match = /^git_identity:\s*(?<gitIdentity>.+)$/mu.exec(markdown);
  if (match === null) return '';
  const gitIdentity = match.groups?.gitIdentity;
  return gitIdentity === undefined ? '' : gitIdentity.trim();
}

function upsertFrontmatterField(frontmatter: string, key: string, value: string): string {
  const fieldPattern = new RegExp(`^${escapeRegExp(key)}:.*$`, 'mu');
  if (fieldPattern.test(frontmatter)) {
    return frontmatter.replace(fieldPattern, `${key}: ${value}`);
  }

  const lines = frontmatter.split('\n');
  const closeIndex = lines.lastIndexOf(FRONTMATTER_CLOSE);
  const insertIndex = closeIndex === -1 ? lines.length : closeIndex;
  lines.splice(insertIndex, 0, `${key}: ${value}`);
  return lines.join('\n');
}

function removeFrontmatterField(frontmatter: string, key: string): string {
  const fieldPattern = new RegExp(`^${escapeRegExp(key)}:.*\\n?`, 'mu');
  return frontmatter.replace(fieldPattern, '');
}
