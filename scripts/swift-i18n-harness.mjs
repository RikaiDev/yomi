#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sourceRoot = join(root, 'desktop', 'mac-native')
const baselinePath = join(root, 'scripts', 'swift-i18n-baseline.json')
const patterns = [
  [
    'feedbackAssignment',
    /\b(?:replyFeedback|stickerLoadError)\s*=\s*"((?:\\.|[^"\\])*)"/g,
  ],
  ['failureMessage', /\bfailureMessage:\s*"((?:\\.|[^"\\])*)"/g],
  ['Text', /\bText\(\s*"((?:\\.|[^"\\])*)"/g],
  ['Button', /\bButton\(\s*"((?:\\.|[^"\\])*)"/g],
  ['Label', /\bLabel\(\s*"((?:\\.|[^"\\])*)"/g],
  ['TextField', /\bTextField\(\s*"((?:\\.|[^"\\])*)"/g],
  ['help', /\.help\(\s*"((?:\\.|[^"\\])*)"/g],
  [
    'accessibilityLabel',
    /\.accessibilityLabel\(\s*"((?:\\.|[^"\\])*)"/g,
  ],
]

function filesUnder(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'Yomi.app') files.push(...filesUnder(path))
    } else if (entry.name.endsWith('.swift') && entry.name !== 'I18n.swift') {
      files.push(path)
    }
  }
  return files
}

function findings() {
  const counts = {}
  for (const path of filesUnder(sourceRoot)) {
    const source = readFileSync(path, 'utf8')
    const lines = source.split('\n')
    for (const [kind, pattern] of patterns) {
      pattern.lastIndex = 0
      for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
        const line = source.slice(0, match.index).split('\n').length
        if (lines[line - 1]?.includes('i18n-harness: allow')) continue
        const text = match[1].replace(/\s+/g, ' ').trim()
        if (!text) continue
        const key = `${relative(root, path)}|${kind}|${text}`
        counts[key] = (counts[key] ?? 0) + 1
      }
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  )
}

const current = findings()
if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`)
  console.log(
    `[swift-i18n] baseline updated (${Object.keys(current).length} fingerprints)`,
  )
  process.exit(0)
}
if (!existsSync(baselinePath)) {
  console.error('[swift-i18n] missing baseline; run with --update intentionally')
  process.exit(1)
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const regressions = Object.entries(current).filter(
  ([key, count]) => count > (baseline[key] ?? 0),
)
if (regressions.length > 0) {
  console.error('[swift-i18n] new visible hardcoded strings:')
  for (const [key, count] of regressions) {
    console.error(`  ${key} (+${count - (baseline[key] ?? 0)})`)
  }
  process.exit(1)
}
console.log(
  `[swift-i18n] pass (${Object.keys(current).length} legacy fingerprints tracked)`,
)
