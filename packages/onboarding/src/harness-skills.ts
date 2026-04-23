import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { env } from 'node:process';

const ENGRAM_SKILL_SLUGS = [
  'engram-bootstrap',
  'engram-scratch',
  'engram-memory',
  'engram-thread',
  'engram-inbox',
  'engram-note',
  'engram-closeout',
] as const;

const SKILL_DOC = 'SKILL.md';
const SINGULAR_COUNT = 1;

function homeDir(): string {
  return env.HOME ?? '';
}

function agentsSkillsPath(): string {
  return path.join(homeDir(), '.agents', 'skills');
}

function legacyPiSkillsPath(): string {
  return path.join(homeDir(), '.pi', 'agent', 'skills');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function copyDirectory(sourceDir: string, targetDir: string): Promise<void> {
  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await fs.cp(sourceDir, targetDir, { recursive: true, force: true });
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

export async function configureAgentsSkills(skillsSourceDir: string): Promise<string[]> {
  const actions = await installSkillBundle(skillsSourceDir, agentsSkillsPath(), '~/.agents');
  const legacyCleanup = await removeSkillBundle(legacyPiSkillsPath(), 'legacy Pi');
  return [...actions, ...legacyCleanup.map((entry) => `legacy cleanup: ${entry}`)];
}

export async function removeAgentsSkills(): Promise<string[]> {
  const actions = await removeSkillBundle(agentsSkillsPath(), '~/.agents');
  const legacyCleanup = await removeSkillBundle(legacyPiSkillsPath(), 'legacy Pi');
  return [...actions, ...legacyCleanup.map((entry) => `legacy cleanup: ${entry}`)];
}

async function installSkillBundle(
  sourceRoot: string,
  targetRoot: string,
  label: string,
): Promise<string[]> {
  if (!(await directoryExists(sourceRoot))) {
    return [`skipped install: ${sourceRoot} was not found`];
  }

  await fs.mkdir(targetRoot, { recursive: true });

  const actions = (await Promise.all(
    ENGRAM_SKILL_SLUGS.map(async (slug) => {
      const sourceDir = path.join(sourceRoot, slug);
      const sourceSkillDoc = path.join(sourceDir, SKILL_DOC);
      if (!(await fileExists(sourceSkillDoc))) {
        return `skipped ${slug}: source SKILL.md missing`;
      }

      const targetDir = path.join(targetRoot, slug);
      await copyDirectory(sourceDir, targetDir);
      return `installed ${slug} to ${targetDir}`;
    }),
  )).filter(isDefined);

  if (actions.length === 0) {
    return [`no ${label} skill files were installed`];
  }

  return actions;
}

async function removeSkillBundle(targetRoot: string, label: string): Promise<string[]> {
  const actions = (await Promise.all(
    ENGRAM_SKILL_SLUGS.map(async (slug) => {
      const targetDir = path.join(targetRoot, slug);
      if (!(await directoryExists(targetDir))) {
        return undefined;
      }

      await fs.rm(targetDir, { recursive: true, force: true });
      return `removed ${slug} from ${targetDir}`;
    }),
  )).filter(isDefined);

  if (actions.length === 0) {
    return [];
  }

  actions.unshift(`removed ${actions.length} ${label} skill director${actions.length === SINGULAR_COUNT ? 'y' : 'ies'}`);
  return actions;
}
