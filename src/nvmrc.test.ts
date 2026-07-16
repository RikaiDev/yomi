import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * `.nvmrc` and `engines.node` say the same thing to different audiences and
 * neither tool reads the other: nvm does not look at package.json at all (its
 * README documents only .nvmrc), and npm's engines check does not consult
 * .nvmrc. So they can drift apart silently — a contributor's `nvm use` would
 * hand them a Node that engines forbids, or vice versa.
 *
 * .nvmrc also cannot hold the range itself: nvm rejects semver ranges and takes
 * only an exact version, a major, or an alias. Hence this guard rather than a
 * shared source.
 */
test('.nvmrc selects a Node that satisfies package.json engines.node', () => {
  const nvmrc = readFileSync(join(ROOT, '.nvmrc'), 'utf8').trim()
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const engines: string = pkg.engines?.node ?? ''

  const min = engines.match(/^>=\s*(\d+)\.(\d+)\.(\d+)$/)
  expect(min).not.toBeNull()
  const nvmrcMajor = nvmrc.match(/^(\d+)$/)
  expect(nvmrcMajor).not.toBeNull()

  // A bare major in .nvmrc resolves to that line's newest release, so it
  // satisfies the floor whenever its major is strictly greater. Equal majors
  // would need the minor compared, which this repo does not currently pin.
  expect(Number(nvmrcMajor![1])).toBeGreaterThan(Number(min![1]))
})
