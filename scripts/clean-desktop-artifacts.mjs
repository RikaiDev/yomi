#!/usr/bin/env node

/**
 * Remove generated desktop build products without touching source, user data,
 * or installed applications.
 *
 * The desktop Rust target is intentionally kept between incremental builds,
 * but it can grow to multiple GiB because debug dependencies and incremental
 * object files are retained for every target. Run `npm run desktop:clean` when
 * reclaiming workspace storage, or pass `--all` to also remove staged release
 * bundles and MCPB build outputs.
 */

import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const all = process.argv.includes('--all')

const exactPaths = [
  join(root, 'desktop', 'target'),
  join(root, 'desktop', 'mac-native', 'Yomi'),
  join(root, 'desktop', 'mac-native', 'Yomi.app', 'Contents', 'MacOS', 'Yomi'),
]

const generatedDesktopResources = [
  join(root, 'desktop', 'mac-native', 'Yomi.app', 'Contents', 'Info.plist'),
  join(root, 'desktop', 'mac-native', 'Yomi.app', 'Contents', 'Resources', 'AppIcon.icns'),
  join(root, 'desktop', 'mac-native', 'Yomi.app', 'Contents', 'Resources', 'YomiKomainuLine.svg'),
  join(root, 'desktop', 'mac-native', 'Yomi.app', 'Contents', 'Resources', 'YomiKomainuAgent.svg'),
]

const generatedDirectories = all
  ? [join(root, 'build', 'desktop-release'), join(root, 'build', 'desktop-core-macos'), join(root, 'build', 'desktop-core-windows')]
  : []

if (all) {
  const buildRoot = join(root, 'build')
  if (existsSync(buildRoot) && lstatSync(buildRoot).isDirectory()) {
    for (const name of readdirSync(buildRoot)) {
      if (name.startsWith('mcpb-')) generatedDirectories.push(join(buildRoot, name))
    }
  }
}

const targets = [...exactPaths, ...generatedDesktopResources, ...generatedDirectories]
let removed = 0
for (const target of targets) {
  if (!existsSync(target)) continue
  rmSync(target, { recursive: true, force: true })
  removed += 1
  console.log(`[desktop:clean] removed ${target}`)
}

console.log(`[desktop:clean] ${removed} generated path(s) removed${all ? ' (including release staging)' : ''}`)
