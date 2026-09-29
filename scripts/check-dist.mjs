#!/usr/bin/env node
/**
 * Fails the production build if the shipped bundle still advertises the
 * development credentials.
 *
 * The SPA gates the login hint behind `import.meta.env.DEV`, and this is the
 * check that the guard survived minification and tree-shaking. It lives in the
 * build rather than the unit suite on purpose: a test that reads
 * `frontend/dist` can only ever report on the *last* build, so editing the
 * source without rebuilding makes it fail for a reason that has nothing to do
 * with the code in front of you.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const assets = fileURLToPath(new URL('../frontend/dist/assets/', import.meta.url));
const FORBIDDEN = ['temp123', 'Dev default:'];

let checked = 0;
for (const file of readdirSync(assets)) {
  if (!file.endsWith('.js')) continue;
  checked++;
  const text = readFileSync(join(assets, file), 'utf8');
  for (const needle of FORBIDDEN) {
    if (text.includes(needle)) {
      console.error(
        `FATAL: ${file} contains ${JSON.stringify(needle)} — the development hint leaked into the production bundle`,
      );
      process.exit(1);
    }
  }
}

console.log(`dist check: ${checked} bundle(s) carry no development credentials`);
