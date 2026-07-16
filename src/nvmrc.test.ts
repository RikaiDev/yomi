import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `.nvmrc` and `engines.node` state one requirement to two tools that cannot
 * see each other: nvm never reads package.json (its README documents only
 * .nvmrc), and npm's engines check never reads .nvmrc. Two statements of one
 * fact drift, so this guards them the way version.test.ts guards version.ts
 * against package.json.
 *
 * .nvmrc cannot just hold the range: nvm rejects semver ranges and accepts only
 * an exact version, a bare major, or an alias.
 */
test('.nvmrc selects a Node line where every release satisfies engines.node', () => {
  const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const engines: string = pkg.engines?.node ?? ''
  expect(engines).not.toBe('')

  const major = nvmrc.match(/^(\d+)$/)?.[1]
  expect(major).toBeDefined()

  // `nvm use 24` resolves to the newest 24.x *that machine happens to have*,
  // which can be older than the floor. So the line qualifies only if its OLDEST
  // possible release satisfies engines — checking the newest would pass here and
  // still hand a contributor an unusable Node.
  expect(Bun.semver.satisfies(`${major}.0.0`, engines)).toBe(true)
})

test('engines.node excludes the Node 23 releases that lack unflagged node:sqlite', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const engines: string = pkg.engines.node

  // node:sqlite was unflagged in 22.13.0 AND 23.4.0 (nodejs/node#55890), so the
  // 23 line splits: 23.0-23.3 are semver-newer than 22.13 yet still lack the
  // module. A plain `>=22.13.0` would admit them and then fail at runtime with
  // "No such built-in module". Those cases are why the range is a disjunction,
  // and they are what this pins.
  for (const unsupported of ['20.20.1', '22.12.0', '23.0.0', '23.3.9']) {
    expect(Bun.semver.satisfies(unsupported, engines)).toBe(false)
  }
  for (const supported of [
    '22.13.0',
    '22.20.0',
    '23.4.0',
    '24.0.0',
    '26.5.0',
  ]) {
    expect(Bun.semver.satisfies(supported, engines)).toBe(true)
  }
})
