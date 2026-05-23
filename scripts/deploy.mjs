/**
 * Deploy the built plugin to the OmniVault template and optionally a live vault.
 *
 * Usage:
 *   node scripts/deploy.mjs                           # OmniVault only
 *   node scripts/deploy.mjs --vault "D:\obsidian\MyVault"   # also a live vault
 *
 * The plugin bundles everything EXCEPT pdf-parse and js-tiktoken (they load
 * __dirname-relative assets at runtime). Those two are copied alongside main.js.
 */

import { copyFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'fs';
import { join, resolve } from 'path';

const PLUGIN_ID   = 'pageindex-rag';
const DIST_FILES  = ['main.js', 'manifest.json', 'styles.css'];
const RUNTIME_MODULES = ['pdf-parse', 'js-tiktoken']; // must live in plugin/node_modules/
const OMNI_VAULT  = 'D:\\obsidian\\OmniVault';

// ── Recursive copy ─────────────────────────────────────────────────────────────

function copyDir(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dest, entry);
    if (statSync(s).isDirectory()) copyDir(s, d);
    else copyFileSync(s, d);
  }
}

// ── Deploy to one vault ────────────────────────────────────────────────────────

function deployTo(vaultPath) {
  if (!existsSync(vaultPath)) {
    console.error(`Vault not found: ${vaultPath}`);
    return false;
  }

  const pluginDir = join(vaultPath, '.obsidian', 'plugins', PLUGIN_ID);
  mkdirSync(pluginDir, { recursive: true });

  // 1. Built artifacts
  for (const file of DIST_FILES) {
    if (!existsSync(file)) {
      console.error(`Missing build artifact: ${file}. Run "npm run build" first.`);
      return false;
    }
    copyFileSync(file, join(pluginDir, file));
    console.log(`  Copied ${file}`);
  }

  // 2. Runtime node_modules that esbuild left external
  const nmSrc  = join('node_modules');
  const nmDest = join(pluginDir, 'node_modules');
  for (const mod of RUNTIME_MODULES) {
    const src = join(nmSrc, mod);
    if (!existsSync(src)) {
      console.warn(`  Warning: node_modules/${mod} not found — run "npm install" first`);
      continue;
    }
    const dest = join(nmDest, mod);
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    copyDir(src, dest);
    console.log(`  Copied node_modules/${mod}`);
  }

  console.log(`✓ Deployed to ${pluginDir}\n`);
  return true;
}

// ── Main ───────────────────────────────────────────────────────────────────────

const vaultArg = process.argv.findIndex(a => a === '--vault');
const extraVault = vaultArg >= 0 ? process.argv[vaultArg + 1] : null;

console.log('\nDeploying PageIndex RAG plugin...\n');
deployTo(OMNI_VAULT);
if (extraVault) deployTo(resolve(extraVault));

console.log('Done. Reload Obsidian or toggle the plugin to pick up changes.\n');
