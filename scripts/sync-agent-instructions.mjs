#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const sourcePath = path.join(repoRoot, "AGENTS.md");
const targetPath = path.join(repoRoot, ".claude", "CLAUDE.md");
const checkOnly = process.argv.includes("--check");

const generatedHeader =
  "<!-- GENERATED FROM AGENTS.md. DO NOT EDIT .claude/CLAUDE.md DIRECTLY. -->\n\n";

const source = fs.readFileSync(sourcePath, "utf8");
const expected = generatedHeader + source;
const current = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";

if (checkOnly) {
  if (current !== expected) {
    console.error(".claude/CLAUDE.md is out of sync with AGENTS.md");
    process.exit(1);
  }

  console.log(".claude/CLAUDE.md is in sync with AGENTS.md");
  process.exit(0);
}

fs.mkdirSync(path.dirname(targetPath), { recursive: true });
fs.writeFileSync(targetPath, expected);
console.log("Synced AGENTS.md -> .claude/CLAUDE.md");
