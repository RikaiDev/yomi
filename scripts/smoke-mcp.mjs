#!/usr/bin/env node
/**
 * Install-smoke: start the packaged Yomi as a real MCP stdio server, complete an
 * `initialize` handshake, and then actually CALL A TOOL that touches the local
 * index.
 *
 * Run against an INSTALLED tarball (node_modules), never the repo checkout —
 * the two behave differently, and only the installed shape is what users get.
 *
 * Why it calls a tool, and not just `initialize`:
 *
 * Every 0.1.x release shipped TypeScript sources and died on startup with
 * ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. CI missed it because it
 * smoke-tested `--help`, the one command that prints a literal string without
 * importing anything. So the gate was deepened to `initialize`.
 *
 * `initialize` then became the new `--help`. It answers from the server shell
 * without touching application code, so v0.1.0–v0.2.1 all shipped green while
 * every index-backed tool (search_messages, get_scope_policy,
 * list_excluded_chats, exclude_chats, include_chats) threw
 * "require is not defined" the moment a user called one: src/search/sqlite.ts
 * used a bare `require` to pick bun:sqlite vs node:sqlite, which bun tolerates
 * in ESM and node does not. Nothing in CI could see it — the test suite runs on
 * bun, and the one node-based check stopped at the handshake.
 *
 * The lesson keeps being the same one: a check that never reaches application
 * code proves nothing about the artifact. Keep this gate calling a real tool,
 * on node, against the installed tarball.
 *
 * get_scope_policy is the tool of choice because it needs no LINE session (it is
 * on the server's no-session-exempt list) but does open the SQLite index.
 *
 * Usage: node smoke-mcp.mjs <path-to-run.mjs>
 */

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = process.argv[2]
if (!entry) {
  console.error('usage: smoke-mcp.mjs <path-to-run.mjs>')
  process.exit(2)
}

// Point the index at a throwaway db so the probe is deterministic and never
// touches a real one.
const dbPath = join(mkdtempSync(join(tmpdir(), 'yomi-smoke-')), 'index.db')

const child = spawn(process.execPath, [entry, 'serve'], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, YOMI_INDEX_DB_PATH: dbPath },
})

let stdout = ''
let stderr = ''
let pending = ''
let answeredInitialize = false

const timer = setTimeout(() => fail('timed out after 30s'), 30_000)

/** Print diagnostics and exit non-zero. */
function fail(reason) {
  clearTimeout(timer)
  child.kill()
  console.error(`FAIL: ${reason}`)
  if (stdout) console.error(`--- stdout ---\n${stdout}`)
  if (stderr) console.error(`--- stderr ---\n${stderr}`)
  process.exit(1)
}

/** Print success and exit zero. */
function pass(message) {
  clearTimeout(timer)
  child.kill()
  console.log(`OK: ${message}`)
  process.exit(0)
}

/** Write one JSON-RPC message to the server's stdin. */
function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`)
}

child.on('error', (error) => fail(`could not spawn server: ${error.message}`))

// A server that dies before answering (the 0.1.x failure mode) lands here.
child.on('exit', (code) => {
  if (!answeredInitialize) {
    fail(`server exited (code ${code}) without answering initialize`)
  }
})

child.stderr.on('data', (chunk) => {
  stderr += chunk
})

child.stdout.on('data', (chunk) => {
  stdout += chunk
  pending += chunk
  const lines = pending.split('\n')
  pending = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue
    let response
    try {
      response = JSON.parse(line)
    } catch {
      continue
    }
    handle(response)
  }
})

/**
 * Advance the probe as each JSON-RPC response arrives.
 *
 * @param response - One parsed JSON-RPC message from the server.
 */
function handle(response) {
  if (response.id === 1) {
    const info = response?.result?.serverInfo
    if (!info) fail(`initialize returned no serverInfo: ${JSON.stringify(response)}`)
    answeredInitialize = true
    send({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_scope_policy', arguments: {} },
    })
    return
  }

  if (response.id === 2) {
    if (response.error) {
      fail(`get_scope_policy failed at the protocol level: ${JSON.stringify(response.error)}`)
    }
    const text = response?.result?.content?.[0]?.text ?? ''
    // isError means the tool ran but reported failure — which is exactly how the
    // bare-require bug surfaced to users, so it must fail the gate.
    if (response?.result?.isError) {
      fail(`get_scope_policy returned an error result: ${text}`)
    }
    if (!text) {
      fail(`get_scope_policy returned no content: ${JSON.stringify(response)}`)
    }
    pass(`server answered initialize and get_scope_policy returned ${text.length} bytes`)
  }
}

send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'install-smoke', version: '0' },
  },
})
