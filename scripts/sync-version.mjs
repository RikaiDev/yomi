/**
 * Rewrite src/version.ts's YOMI_VERSION to match package.json's "version".
 *
 * Run automatically by the `version` npm lifecycle script (i.e. by
 * `npm version patch|minor|major`), so the two version sources can never
 * drift. Node-only, zero deps — works in any environment npm runs in.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const versionFile = new URL('../src/version.ts', import.meta.url);
const src = readFileSync(versionFile, 'utf8');

const pattern = /(export const YOMI_VERSION = ')[^']*(')\s*;?/;
if (!pattern.test(src)) {
  console.error('sync-version: could not find the YOMI_VERSION line in src/version.ts');
  process.exit(1);
}

const next = src.replace(pattern, `$1${pkg.version}$2`);
if (next !== src) {
  writeFileSync(versionFile, next);
}
console.log(`sync-version: src/version.ts YOMI_VERSION -> ${pkg.version}`);
