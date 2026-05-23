/**
 * Deploy the built plugin to the OmniVault template and optionally a live vault.
 *
 * Usage:
 *   node scripts/deploy.mjs                  # deploy to OmniVault only
 *   node scripts/deploy.mjs --vault "D:\obsidian\MyVault"   # also deploy to a live vault
 */

import { copyFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';

const PLUGIN_ID = 'pageindex-rag';
const FILES = ['main.js', 'manifest.json', 'styles.css'];

const OMNI_VAULT = 'D:\\obsidian\\OmniVault';

function deployTo(vaultPath) {
  const pluginDir = join(vaultPath, '.obsidian', 'plugins', PLUGIN_ID);

  if (!existsSync(vaultPath)) {
    console.error(`Vault not found: ${vaultPath}`);
    return false;
  }

  mkdirSync(pluginDir, { recursive: true });

  for (const file of FILES) {
    if (!existsSync(file)) {
      console.error(`Missing build artifact: ${file}. Run "npm run build" first.`);
      return false;
    }
    copyFileSync(file, join(pluginDir, file));
    console.log(`  Copied ${file} → ${pluginDir}`);
  }

  console.log(`✓ Deployed to ${pluginDir}`);
  return true;
}

// Parse --vault argument
const vaultArg = process.argv.findIndex(a => a === '--vault');
const extraVault = vaultArg >= 0 ? process.argv[vaultArg + 1] : null;

console.log('\nDeploying PageIndex RAG plugin...\n');

deployTo(OMNI_VAULT);

if (extraVault) {
  console.log('');
  deployTo(resolve(extraVault));
}

console.log('\nDone. Reload Obsidian or toggle the plugin to pick up changes.\n');
