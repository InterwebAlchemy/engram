#!/usr/bin/env node

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(dirname, '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const sourceDir = path.join(repoRoot, 'packages', 'obsidian-plugin');
const targetDir = path.join(packageRoot, 'obsidian-plugin');
const pluginFiles = ['main.js', 'manifest.json', 'styles.css'];

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyPluginAssets() {
  await fs.mkdir(targetDir, { recursive: true });
  let copiedCount = 0;

  for (const fileName of pluginFiles) {
    const sourcePath = path.join(sourceDir, fileName);
    const targetPath = path.join(targetDir, fileName);

    if (!(await fileExists(sourcePath))) {
      console.warn(`[engram-cli] Skipping ${fileName}; source file not found at ${sourcePath}`);
      continue;
    }

    await fs.copyFile(sourcePath, targetPath);
    copiedCount += 1;
  }

  if (copiedCount === 0) {
    console.warn(`[engram-cli] No Obsidian plugin assets copied from ${sourceDir}`);
  } else {
    console.log(`[engram-cli] Copied ${copiedCount} plugin assets to ${targetDir}`);
  }
}

await copyPluginAssets();
