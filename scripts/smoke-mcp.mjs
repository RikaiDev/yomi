#!/usr/bin/env node
/**
 * Install-smoke: start the packaged Yomi as a real MCP stdio server and
 * assert it completes an `initialize` handshake.
 *
 * Run against an INSTALLED tarball (node_modules), never the repo checkout —
 * the two behave differently, and only the installed shape is what users get.
 * Every 0.1.x release shipped TypeScript sources and died on startup with
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING (Node refuses to strip types
 * under node_modules). CI missed it because it smoke-tested `--help`, the one
 * command that prints a literal string without importing anything.
 *
 * Usage: node smoke-mcp.mjs <path-to-run.mjs>
 */

import { spawn } from 'node:child_process'

const entry = process.argv[2]
if (!entry) {
  console.error('usage: smoke-mcp.mjs <path-to-run.mjs>')
  process.exit(2)
}

const REQUEST = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'install-smoke', version: '0' },
  },
}

const child = spawn(process.execPath, [entry, 'serve'], {
  stdio: ['pipe', 'pipe', 'pipe'],
})

let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk) => {
  stdout += chunk
})
child.stderr.on('data', (chunk) => {
  stderr += chunk
})

const timer = setTimeout(() => {
  fail('timed out after 30s waiting for an initialize response')
}, 30_000)

/** Print diagnostics and exit non-zero. */
function fail(reason) {
  clearTimeout(timer)
  child.kill()
  console.error(`FAIL: ${reason}`)
  if (stdout) console.error(`--- stdout ---\n${stdout}`)
  if (stderr) console.error(`--- stderr ---\n${stderr}`)
  process.exit(1)
}

child.on('error', (error) => fail(`could not spawn server: ${error.message}`))

// A server that dies before answering (the 0.1.x failure mode) lands here.
child.on('exit', (code) => {
  if (!stdout.includes('"serverInfo"')) {
    fail(`server exited (code ${code}) without answering initialize`)
  }
})

child.stdout.on('data', () => {
  if (!stdout.includes('\n')) return
  const line = stdout.split('\n').find((l) => l.trim().startsWith('{'))
  if (!line) return

  let response
  try {
    response = JSON.parse(line)
  } catch {
    return // partial line; wait for more
  }

  const info = response?.result?.serverInfo
  if (!info) fail(`initialize returned no serverInfo: ${line}`)

  clearTimeout(timer)
  child.kill()
  console.log(`OK: ${info.name} ${info.version} answered initialize`)
  process.exit(0)
})

child.stdin.write(`${JSON.stringify(REQUEST)}\n`)
