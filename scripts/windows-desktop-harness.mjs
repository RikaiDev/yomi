#!/usr/bin/env node
/**
 * Build and runtime-independent quality gate for the Windows desktop app.
 * Cross-compilation is checked on non-Windows hosts; the release executable
 * is built on Windows, where the MSVC linker and WebView2 SDK are available.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const desktop = join(root, 'desktop')
const target = 'x86_64-pc-windows-msvc'
const sourceFiles = [
  join(desktop, 'src', 'main.rs'),
  join(desktop, 'src', 'agent', 'mod.rs'),
  join(desktop, 'src', 'platform.rs'),
  join(desktop, 'src', 'auth', 'keychain.rs'),
  join(desktop, 'src', 'auth', 'login.rs'),
  join(desktop, 'src', 'events.rs'),
  join(desktop, 'src', 'popover', 'mod.rs'),
  join(desktop, 'src', 'popover', 'view.html'),
  join(desktop, 'src', 'popover', 'view.css'),
  join(desktop, 'src', 'popover', 'view.js'),
  join(desktop, 'src', 'notification', 'mod.rs'),
]

function fail(message) {
  console.error(`[desktop:windows:harness] ${message}`)
  process.exit(1)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' })
  if (result.status !== 0) fail(`${command} ${args.join(' ')} failed (${result.status ?? 'signal'})`)
}

const source = sourceFiles.map((path) => readFileSync(path, 'utf8')).join('\n')
if (!source.includes('APPDATA') || !source.includes('target_os = "windows"')) {
  fail('Windows credential path support is missing')
}
if (!source.includes('Command::new("cmd")') || !source.includes('target_os = "windows"')) {
  fail('Windows default-browser integration is missing')
}
if (!source.includes('join("YomiCore").join("run.mjs")') || !source.includes('"node.exe"')) {
  fail('Windows release must resolve the bundled Node and YomiCore runtime')
}
if (!source.includes('login_start:') || (!source.includes('Continue on this computer') && !source.includes('在此電腦繼續'))) {
  fail('Windows desktop must provide an in-app LINE login form and IPC bridge')
}
if (!source.includes('PIN:') || !source.includes('WaitingApproval') || !source.includes('RefreshAccount')) {
  fail('Windows login must surface PIN progress and refresh the account after success')
}
if (source.includes('info!("Popover action triggered: {}", action)')) {
  fail('desktop logging must not persist phone numbers or coding prompts from IPC payloads')
}
for (const provider of ['codex', 'claude', 'antigravity', 'opencode', 'ollama']) {
  if (!source.includes(`id: "${provider}"`)) fail(`coding provider is not wired: ${provider}`)
}
if (!source.includes('YOMI_MCP_TOOLS') || !source.includes('allYomiMcpToolsEnabled')) {
  fail('coding tools must enable the complete Yomi MCP surface by default')
}
for (const wiring of [
  'CodingToolRegistry::detect()',
  'coding_tool_run:',
  '.run(Some(request.provider.as_str())',
  'auto_detected',
  'enabled: true',
]) {
  if (!source.includes(wiring)) fail(`coding tool runtime wiring is missing: ${wiring}`)
}
for (const wiring of [
  'briefing_title', 'showBriefing', 'state.selected = null',
  'class="tracking-row"', 'Yomi Tracking',
  'trackingDetail', 'tracking-evidence', 'item.ocrText',
  'flexDocument', 'class="carousel', '286px',
  'n.resolved.aspectRatio', 'n.resolved.contentMode', 'n.resolved.fontSize', 'data-layout-fingerprint',
  '.flex {', 'background: transparent',
  'm.mediaType === "audio"', 'm.mediaType === "call"', 'isDecryptFailure',
  'renderEmojiText', 'class="inline-emoji"',
  'state.attachments', 'state.attachments.length', 'dropzone', 'capture="environment"',
  'send-audio', 'coding_tool_run:', 'localStorage.setItem', 'yomi-appearance',
  'yomi-sync', 'yomi-notifications',
  'loginTimer', 'login_cancel', 'state.generation', 'setInterval(() => {',
  'if (state.messages.length)', 'bridge("mark:"',
  'pendingReads', 'chat.timestamp || 0) <= cursor.timestamp',
]) {
  if (!source.includes(wiring)) fail(`Windows parity surface is missing: ${wiring}`)
}

run('npm', ['run', 'build'])
run('npm', ['run', 'lint'])
run('npm', ['run', 'lint:comments'])
run('npm', ['run', 'desktop:windows:i18n'])
run('cargo', ['fmt', '--manifest-path', join(desktop, 'Cargo.toml'), '--', '--check'])
run('cargo', ['clippy', '--manifest-path', join(desktop, 'Cargo.toml'), '--all-targets', '--', '-D', 'warnings'])
run('cargo', ['test', '--manifest-path', join(desktop, 'Cargo.toml')])
run('cargo', [
  'clippy',
  '--manifest-path',
  join(desktop, 'Cargo.toml'),
  '--target',
  target,
  '--',
  '-D',
  'warnings',
])

if (process.platform === 'win32') {
  run('cargo', ['build', '--manifest-path', join(desktop, 'Cargo.toml'), '--release', '--target', target])
  const executable = join(desktop, 'target', target, 'release', 'yomi-desktop.exe')
  if (!existsSync(executable)) fail('Windows release executable was not produced')
} else {
  run('cargo', ['check', '--manifest-path', join(desktop, 'Cargo.toml'), '--target', target])
}

console.log('[desktop:windows:harness] source, lint, tests, and Windows target checks passed')
