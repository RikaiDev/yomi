import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { YOMI_VERSION } from './version.js';

/**
 * `YOMI_VERSION` is a hand-maintained build-time constant (see version.ts's
 * JSDoc for why it can't be a runtime package.json read). This test is the
 * drift guard: it reads package.json directly (fine here — tests always run
 * under `bun test` from source, never inside a compiled binary) and fails
 * the moment someone bumps package.json's "version" without updating
 * version.ts to match.
 */
test('YOMI_VERSION matches package.json version', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
  expect(YOMI_VERSION).toBe(packageJson.version);
});
