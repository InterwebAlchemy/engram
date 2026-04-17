#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const sourcePath = path.join(repoRoot, "agent-instructions.tmpl.md");
const checkOnly = process.argv.includes("--check");

const allTargets = {
  agents: path.join(repoRoot, "AGENTS.md"),
  claude: path.join(repoRoot, ".claude", "CLAUDE.md"),
};

// Determine which targets to sync based on CLI args.
// --target=agents | --target=claude | (no flag = both, for pre-commit)
const targetArg = process.argv.find((a) => a.startsWith("--target="));
const targetKey = targetArg ? targetArg.split("=")[1] : undefined;

const targets =
  targetKey && targetKey in allTargets
    ? [allTargets[targetKey]]
    : Object.values(allTargets);

const generatedHeader =
  "<!-- GENERATED FROM agent-instructions.tmpl.md — do not edit directly. -->\n\n";

const source = fs.readFileSync(sourcePath, "utf8");
const expected = generatedHeader + source;

if (checkOnly) {
  let ok = true;
  for (const target of targets) {
    const rel = path.relative(repoRoot, target);
    const current = fs.existsSync(target)
      ? fs.readFileSync(target, "utf8")
      : "";
    if (current !== expected) {
      console.error(`${rel} is out of sync with agent-instructions.tmpl.md`);
      ok = false;
    } else {
      console.log(`${rel} is in sync`);
    }
  }
  process.exit(ok ? 0 : 1);
}

for (const target of targets) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, expected);
  console.log(
    `Synced agent-instructions.tmpl.md -> ${path.relative(repoRoot, target)}`
  );
}
