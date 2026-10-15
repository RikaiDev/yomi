#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = process.argv.slice(2)
const valueOf = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const fail = (message) => {
  console.error(`[desktop:qos] ${message}`)
  process.exit(1)
}
const percentile = (values, value) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * value) - 1)]
}

const samples = Number(process.env.YOMI_DESKTOP_QOS_SAMPLES || 7)
const startupBudgetMs = Number(process.env.YOMI_DESKTOP_STARTUP_P95_MS || 1000)
const bundleStartupBudgetMs = Number(process.env.YOMI_DESKTOP_BUNDLE_STARTUP_P95_MS || 1500)
const runtimeMemoryBudgetMb = Number(process.env.YOMI_DESKTOP_RUNTIME_RSS_MB || 220)
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

function processRows() {
  if (process.platform === 'win32') return []
  const result = spawnSync('ps', ['-axo', 'pid=,ppid=,rss=,etime=,command='], { encoding: 'utf8' })
  if (result.status !== 0) fail(`process inspection failed: ${result.stderr}`)
  return result.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/)
    return match ? { pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), elapsed: match[4], command: match[5] } : null
  }).filter(Boolean)
}

function elapsedSeconds(value) {
  const parts = value.split('-')
  const days = parts.length === 2 ? Number(parts[0]) : 0
  const clock = parts.at(-1).split(':').map(Number)
  const [hours, minutes, seconds] = clock.length === 3 ? clock : [0, clock[0], clock[1]]
  return days * 86400 + hours * 3600 + minutes * 60 + seconds
}

function assertNoLeakedBuildProcesses(rows) {
  const markers = ['scripts/package-desktop-core.mjs', 'bun run build', '/typescript-darwin-arm64/lib/tsc']
  const leaked = rows.filter((row) =>
    elapsedSeconds(row.elapsed) > 120 &&
    row.command.includes(root) &&
    markers.some((marker) => row.command.includes(marker)))
  if (leaked.length) fail(`stale build process leak: ${leaked.map((row) => `${row.pid} ${row.elapsed} ${row.command}`).join(' | ')}`)
}

const inspectedRows = processRows()
assertNoLeakedBuildProcesses(inspectedRows)

const runtimePid = Number(valueOf('--runtime-pid') || 0)
if (runtimePid > 0 && process.platform !== 'win32') {
  const family = new Set([runtimePid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of inspectedRows) {
      if (family.has(row.ppid) && !family.has(row.pid)) { family.add(row.pid); changed = true }
    }
  }
  const runtimeRows = inspectedRows.filter((row) => family.has(row.pid))
  if (!runtimeRows.some((row) => row.pid === runtimePid)) fail(`runtime pid ${runtimePid} not found`)
  const rssMb = runtimeRows.reduce((sum, row) => sum + row.rssKb, 0) / 1024
  console.log(`[desktop:qos] runtime process-tree RSS=${rssMb.toFixed(1)}MB budget=${runtimeMemoryBudgetMb}MB processes=${runtimeRows.length}`)
  if (rssMb > runtimeMemoryBudgetMb) fail(`runtime RSS ${rssMb.toFixed(1)}MB exceeds ${runtimeMemoryBudgetMb}MB`)
}

const cacheBinary = join(process.env.TMPDIR || '/tmp', `yomi-cache-qos-${process.pid}`)
const cacheCompile = spawnSync('swiftc', [
  '-framework', 'Security',
  join(root, 'desktop/mac-native/Core/DesktopMessageSnapshotStore.swift'),
  join(root, 'scripts/desktop-cache-qos-main.swift'),
  '-o', cacheBinary,
], { cwd: root, encoding: 'utf8' })
if (cacheCompile.status !== 0) fail(`cache QoS compile failed: ${cacheCompile.stderr || cacheCompile.stdout}`)
const cacheQoS = spawnSync(cacheBinary, [], { cwd: root, encoding: 'utf8', env: process.env })
if (cacheQoS.status !== 0) fail(`cache QoS failed: ${cacheQoS.stderr || cacheQoS.stdout}`)
process.stdout.write(cacheQoS.stdout)

function benchmark(label, executable, commandArgs, cwd, budgetMs) {
  const durations = []
  for (let index = 0; index < samples; index++) {
    const startedAt = performance.now()
    const result = spawnSync(executable, commandArgs, {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, YOMI_SKIP_UPDATE_CHECK: '1' },
      timeout: Math.max(5000, budgetMs * 4),
    })
    durations.push(performance.now() - startedAt)
    if (result.status !== 0 || result.stdout.trim() !== packageJson.version) {
      fail(`${label} smoke failed: ${result.stderr || result.stdout || `status ${result.status}`}`)
    }
  }
  const p50 = percentile(durations, 0.5)
  const p95 = percentile(durations, 0.95)
  console.log(`[desktop:qos] ${label} p50=${p50.toFixed(0)}ms p95=${p95.toFixed(0)}ms budget=${budgetMs}ms`)
  if (p95 > budgetMs) fail(`${label} p95 ${p95.toFixed(0)}ms exceeds ${budgetMs}ms`)
}

benchmark('workspace bridge startup', process.execPath, [join(root, 'run.mjs'), 'version'], root, startupBudgetMs)

const bundle = valueOf('--bundle')
if (bundle) {
  const bundleRoot = resolve(bundle)
  const runtime = join(bundleRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
  const core = join(bundleRoot, 'YomiCore')
  const entry = join(core, 'run.mjs')
  if (!existsSync(runtime) || !existsSync(entry) || !existsSync(join(core, 'node_modules', 'tweetnacl'))) {
    fail(`bundle is not self-contained: ${bundleRoot}`)
  }
  benchmark('bundled bridge startup', runtime, [entry, 'version'], core, bundleStartupBudgetMs)
}

const chatId = process.env.YOMI_QOS_CHAT_ID
if (chatId) {
  const messageBudgetMs = Number(process.env.YOMI_DESKTOP_MESSAGES_BUDGET_MS || 8000)
  const startedAt = performance.now()
  const result = spawnSync(process.execPath, [join(root, 'run.mjs'), 'messages', chatId, '40'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, YOMI_SKIP_UPDATE_CHECK: '1' },
    timeout: 25000,
  })
  const duration = performance.now() - startedAt
  if (result.status !== 0 || !result.stdout.includes('[')) fail(`real message probe failed: ${result.stderr || result.stdout}`)
  console.log(`[desktop:qos] real 40-message probe=${duration.toFixed(0)}ms target=${messageBudgetMs}ms`)
  if (duration > messageBudgetMs) fail(`real message probe exceeds ${messageBudgetMs}ms`)
}
