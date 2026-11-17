import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * `run.mjs` is the entry point every distribution ships — the npm tarball,
 * the MCPB bundle, and the desktop core bundle all start it. It must load the
 * compiled `dist/` and nothing else.
 *
 * A source fallback is the guard against silently running unpublished code:
 * without a build the entry point has to refuse to start, so the only thing a
 * developer can exercise is either a built checkout or the published package.
 */
const runMjs = readFileSync(new URL('../run.mjs', import.meta.url), 'utf-8')

test('run.mjs never falls back to the TypeScript sources', () => {
  expect(runMjs).not.toContain("new URL('./src/'")
  expect(runMjs).not.toContain('YOMI_DEV_SOURCE')
  expect(runMjs).not.toContain("ext = built ? '.js' : '.ts'")
})

test('run.mjs loads modules from dist/ with the .js extension', () => {
  expect(runMjs).toContain("new URL('./dist/'")
  expect(runMjs).toContain("const ext = '.js'")
  expect(runMjs).toContain('new URL(path + ext, base).href')
})

test('run.mjs fails with an actionable message when dist/ is missing', () => {
  expect(runMjs).toContain('dist/mcp/server.js is missing')
  expect(runMjs).toContain('npm run build')
  expect(runMjs).toContain('npm install -g @rikaidev/yomi')
})
