#!/usr/bin/env node
/**
 * Deterministically generate a release's notes from its Conventional Commits.
 *
 * Why this exists: hand-written release notes drift — some releases got long
 * install essays, others a single line, others nothing. This makes the notes a
 * pure function of the commits in the range, so every release reads the same
 * way and the same commits always produce the same text. It is the release-
 * notes analog of the version/tag drift guard in RELEASING.md.
 *
 * Usage:
 *   node scripts/release-notes.mjs [tag] [--from <prevTag>] [--headline "..."]
 *
 *   tag         Tag to describe. Default: the most recent tag (HEAD's).
 *   --from      Range start. Default: the tag immediately before `tag`.
 *   --headline  One optional lead sentence placed above the sections.
 *
 * Emits GitHub-flavored markdown to stdout. Wire it into a release with:
 *   gh release create "vX.Y.Z" --notes "$(node scripts/release-notes.mjs)"
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/**
 * Run git and return trimmed stdout.
 *
 * @param args - git arguments.
 * @returns Command stdout, trimmed.
 */
const git = (args) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    // Discard stderr: a missing predecessor tag (first release) is an expected
    // failure handled by the caller, not something to print.
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()

// Parse argv into flags (--name value) and positionals, so the target tag can
// be given positionally without being confused for a flag value.
const argv = process.argv.slice(2)
const flags = {}
const positionals = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    flags[argv[i].slice(2)] = argv[i + 1]
    i++
  } else {
    positionals.push(argv[i])
  }
}
const optFlag = (name) => flags[name] ?? null

// Resolve the target tag (positional arg, else the newest tag reachable now).
const tag = positionals[0] || git(['describe', '--tags', '--abbrev=0'])

// Resolve the range start: explicit --from, else the tag before `tag`. When
// `tag` is the very first tag there is no predecessor — list `tag`'s full
// reachable history instead (so the root commit is included, not excluded by
// the `A..B` range) and link the footer to the tag rather than a compare.
let from = optFlag('from')
if (!from) {
  try {
    from = git(['describe', '--tags', '--abbrev=0', `${tag}^`])
  } catch {
    from = null // no earlier tag: this is the first release
  }
}
const logRef = from ? `${from}..${tag}` : tag

// Derive the repo web URL from package.json (strip git+ prefix and .git suffix).
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const repoUrl = (pkg.repository?.url ?? '')
  .replace(/^git\+/, '')
  .replace(/\.git$/, '')

// One line per commit: "<shortSha>\t<subject>". Excludes merges.
const lines = git(['log', '--no-merges', '--format=%h%x09%s', logRef])
  .split('\n')
  .filter(Boolean)

/** A pure version-bump commit (npm version, or a `release:`/`chore(release):`
 * tag commit) carries no user-facing change — drop it from the notes. */
const VERSION_BUMP =
  /^((chore\s*\(release\)|chore|release)\s*:\s*)?v?\d+\.\d+\.\d+$/i

/**
 * Conventional-commit type → section. Order here is the render order. Any type
 * not listed (chore, test, docs, build, ci, style, …) folds into "Internal".
 */
const SECTIONS = [
  { key: 'feat', title: '### ✨ Features' },
  { key: 'fix', title: '### 🐛 Fixes' },
  { key: 'perf', title: '### ⚡ Performance' },
  { key: 'refactor', title: '### ♻️ Refactoring' },
  { key: 'internal', title: '### 🔧 Internal' },
]
const buckets = new Map(SECTIONS.map((s) => [s.key, []]))
const breaking = []

const CONVENTIONAL = /^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/

for (const line of lines) {
  const [sha, subject] = line.split('\t')
  if (VERSION_BUMP.test(subject)) {
    continue
  }
  const m = CONVENTIONAL.exec(subject)
  let bucketKey
  let text
  if (m) {
    const [, type, scope, bang, rest] = m
    text = scope ? `**${scope}:** ${rest}` : rest
    // Known section type keeps its bucket; every other type (chore/test/docs/
    // build/ci/style/revert and anything unrecognized) folds into Internal.
    bucketKey = buckets.has(type) ? type : 'internal'
    if (bang) {
      breaking.push(`- ${text} (\`${sha}\`)`)
    }
  } else {
    // Non-conventional subject: keep it verbatim under Internal.
    text = subject
    bucketKey = 'internal'
  }
  buckets.get(bucketKey).push(`- ${text} (\`${sha}\`)`)
}

const out = []
const headline = optFlag('headline')
if (headline) {
  out.push(headline, '')
}
if (breaking.length > 0) {
  out.push('### ⚠️ Breaking changes', ...breaking, '')
}
for (const { key, title } of SECTIONS) {
  const items = buckets.get(key)
  if (items.length > 0) {
    out.push(title, ...items, '')
  }
}
if (repoUrl) {
  out.push(
    from
      ? `**Full changelog:** ${repoUrl}/compare/${from}...${tag}`
      : `**Full changelog:** ${repoUrl}/commits/${tag}`,
  )
}

process.stdout.write(`${out.join('\n').trim()}\n`)
