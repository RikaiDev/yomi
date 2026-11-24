import { expect, test } from 'bun:test'
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isYomiCliEntry } from './server.js'

test('the CLI entry point is recognized through a symlink', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yomi-cli-entry-'))
  const target = join(dir, 'run.mjs')
  const link = join(dir, 'yomi')
  writeFileSync(target, '// entry point\n')
  symlinkSync(target, link)

  // The installed CLI is a symlink, and a client spawns it by that path.
  expect(isYomiCliEntry(link)).toBe(true)
  expect(isYomiCliEntry(target)).toBe(true)
})

test('an unrelated entry point is not the Yomi CLI', () => {
  expect(isYomiCliEntry('/usr/local/bin/some-other-server')).toBe(false)
  expect(isYomiCliEntry(undefined)).toBe(false)
})
