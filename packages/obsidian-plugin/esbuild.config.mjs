import esbuild from 'esbuild';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const watch = process.argv.includes('--watch');
const prod = process.argv.includes('--production');

// ─── Check for Obsidian CLI ─────────────────────────────────────────────────

let hasObsidianCli = false;
try {
  execSync('command -v obsidian', { stdio: 'ignore' });
  hasObsidianCli = true;
} catch {}

// ─── Resolve engram-core source for inline bundling ─────────────────────────

const engramCoreSrc = resolve(__dirname, '../core/src/index.ts');

const resolveEngramCore = {
  name: 'resolve-engram-core',
  setup(build) {
    build.onResolve({ filter: /^@interwebalchemy\/engram-core$/ }, () => ({
      path: engramCoreSrc,
    }));
  },
};

// ─── Auto-reload plugin in Obsidian after successful builds ─────────────────

const reloadOnBuild = {
  name: 'reload-obsidian-plugin',
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const ts = new Date().toLocaleTimeString();
      if (hasObsidianCli) {
        try {
          execSync('obsidian plugin:reload engram', { stdio: 'ignore' });
          console.log(`[${ts}] Plugin reloaded via Obsidian CLI.`);
        } catch {
          // Obsidian not running or CLI not responding — not an error
        }
      } else if (watch) {
        console.log(`[${ts}] Rebuilt. Reload Obsidian to pick up changes.`);
      }
    });
  },
};

// ─── Build ──────────────────────────────────────────────────────────────────

const ctx = await esbuild.context({
  entryPoints: [resolve(__dirname, 'src/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  outfile: resolve(__dirname, 'main.js'),
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  external: [
    'obsidian',
    'electron',
    '@codemirror/autocomplete',
    '@codemirror/collab',
    '@codemirror/commands',
    '@codemirror/language',
    '@codemirror/lint',
    '@codemirror/search',
    '@codemirror/state',
    '@codemirror/view',
    '@lezer/common',
    '@lezer/highlight',
    '@lezer/lr',
  ],
  plugins: [resolveEngramCore, reloadOnBuild],
  define: {
    'process.env.NODE_ENV': prod ? '"production"' : '"development"',
  },
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
