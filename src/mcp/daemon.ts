/**
 * Yomi MCP Shared Daemon.
 *
 * Runs a single, persistent Yomi instance (holding one LINE session, one
 * Transformers embedding model, and one SQLite search index) as a background
 * daemon. Multiple AI clients (OpenCode, Minimax, Claude Code, Cursor, Agy)
 * share this daemon via HTTP/SSE or transparent stdio proxies, eliminating
 * redundant processes, memory duplication, and session race conditions.
 */

import { spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server as HttpServer } from 'node:http'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import {
  createMcpHandler,
  ReadBuffer,
  serializeMessage,
} from '@modelcontextprotocol/server'
import { LineProtocolService } from '../line/core/service.js'
import { startCapture } from '../search/capture.js'
import { getDefaultEmbedder } from '../search/default-embedder.js'
import { yomiDataPath } from '../util/data-dir.js'
import { createCliLogger } from '../util/log.js'
import { checkForUpdate, compareVersions } from '../util/update-check.js'
import { YOMI_VERSION } from '../version.js'
import { NO_CREDENTIALS_MESSAGE } from './handlers/index.js'
import { buildInstructions, createBuildServer } from './server.js'

const log = createCliLogger('YomiDaemon')

export const DEFAULT_DAEMON_PORT = 3333
export const DEFAULT_DAEMON_HOST = '127.0.0.1'

export interface DaemonInfo {
  pid: number
  port: number
  host: string
  startedAt: string
  version: string
}

export function daemonInfoPath(): string {
  return yomiDataPath('daemon.json')
}

export function readDaemonInfo(): DaemonInfo | null {
  const file = daemonInfoPath()
  if (!existsSync(file)) {
    return null
  }
  try {
    const raw = readFileSync(file, 'utf8')
    const data = JSON.parse(raw) as DaemonInfo
    if (!data.pid || !data.port) {
      return null
    }
    // Verify whether the process is actually alive
    try {
      process.kill(data.pid, 0)
      return data
    } catch {
      // Process is dead, clean up stale state file
      try {
        rmSync(file)
      } catch {}
      return null
    }
  } catch {
    return null
  }
}

export async function isDaemonHealthy(info: DaemonInfo): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const res = await fetch(`http://${info.host}:${info.port}/health`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!res.ok) {
      return false
    }
    const json = (await res.json()) as { ok?: boolean }
    return json?.ok === true
  } catch {
    return false
  }
}

export async function getRunningDaemon(): Promise<DaemonInfo | null> {
  const info = readDaemonInfo()
  if (!info) {
    // daemon.json is missing — a daemon may still be running on the default
    // port (e.g. it was started by an older version that wrote the file to a
    // different path, or the file was cleaned up). Probe the default port
    // directly so we don't spawn a competing instance.
    const port = process.env.YOMI_PORT
      ? parseInt(process.env.YOMI_PORT, 10)
      : DEFAULT_DAEMON_PORT
    const probe: DaemonInfo = {
      pid: 0,
      port,
      host: DEFAULT_DAEMON_HOST,
      startedAt: '',
      version: '',
    }
    if (await isDaemonHealthy(probe)) {
      // Reconstruct what we can from the health endpoint.
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        const res = await fetch(
          `http://${DEFAULT_DAEMON_HOST}:${port}/health`,
          {
            signal: controller.signal,
          },
        )
        clearTimeout(timer)
        const json = (await res.json()) as {
          ok?: boolean
          pid?: number
          version?: string
          uptime?: number
        }
        if (json?.ok === true) {
          const reconstructed: DaemonInfo = {
            pid: json.pid ?? 0,
            port,
            host: DEFAULT_DAEMON_HOST,
            startedAt: '',
            version: json.version ?? '',
          }
          return reconstructed
        }
      } catch {}
    }
    return null
  }
  const healthy = await isDaemonHealthy(info)
  if (healthy) {
    return info
  }
  // Check if PID is still alive. If alive, do NOT delete daemon.json (avoid competing instances)
  try {
    process.kill(info.pid, 0)
    return info
  } catch {
    try {
      rmSync(daemonInfoPath())
    } catch {}
    return null
  }
}

export interface StartDaemonOptions {
  port?: number
  host?: string
  service?: LineProtocolService
  quiet?: boolean
}

export async function startDaemonServer(
  options: StartDaemonOptions = {},
): Promise<{ server: HttpServer; port: number; info: DaemonInfo }> {
  const host = options.host ?? DEFAULT_DAEMON_HOST
  const requestedPort =
    options.port ??
    (process.env.YOMI_PORT
      ? parseInt(process.env.YOMI_PORT, 10)
      : DEFAULT_DAEMON_PORT)

  const service = options.service ?? new LineProtocolService()
  service.on('error', (error: any) =>
    log.warn('service.error', { error: error?.message ?? String(error) }),
  )

  const resumed = await service.resumeSession()
  if (!resumed) {
    log.warn('session.resume_failed', { message: NO_CREDENTIALS_MESSAGE })
  } else {
    log.info('session.resumed', { mid: service.profile?.mid ?? null })
    if (process.env.YOMI_NO_CAPTURE !== '1') {
      const embedder =
        process.env.YOMI_EMBEDDINGS === '0' ? undefined : getDefaultEmbedder()
      startCapture(service, embedder).catch((error: any) => {
        log.error('capture.start_failed', {
          error: error?.message ?? String(error),
        })
      })
    }
  }

  const updateNotice = await checkForUpdate()
  if (updateNotice) {
    log.info('update.available', { current: YOMI_VERSION })
  }

  const instructions = buildInstructions(updateNotice)
  const buildServer = createBuildServer(service, instructions)
  const mcpHandler = createMcpHandler(buildServer, {
    legacy: 'stateless',
    onerror: (error) =>
      log.error('server.protocol_error', {
        error: error?.message ?? String(error),
      }),
  })

  const server = createServer(async (req, res) => {
    // Health and status endpoint
    if (req.url === '/health' || req.url === '/status') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          version: YOMI_VERSION,
          pid: process.pid,
          uptime: process.uptime(),
          session: service.profile ? { mid: service.profile.mid } : null,
          loginRequired: service.loginRequired ?? false,
        }),
      )
      return
    }

    // Modern / Streamable HTTP & Legacy MCP endpoint
    const url = `http://${req.headers.host || `${host}:${requestedPort}`}${req.url}`
    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) {
        headers.set(k, Array.isArray(v) ? v.join(', ') : v)
      }
    }

    // Ensure Accept header includes text/event-stream for MCP spec compliance
    const accept = headers.get('accept')
    if (!accept) {
      headers.set('accept', 'application/json, text/event-stream')
    } else if (!accept.includes('text/event-stream')) {
      headers.set('accept', `${accept}, text/event-stream`)
    }

    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : Readable.toWeb(req)

    const webReq = new Request(url, {
      method: req.method,
      headers,
      body,
      duplex: 'half',
    })

    try {
      const webRes = await mcpHandler.fetch(webReq)
      res.writeHead(webRes.status, Object.fromEntries(webRes.headers.entries()))
      if (webRes.body) {
        const reader = webRes.body.getReader()
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
    } catch (error: any) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32603, message: error?.message ?? String(error) },
          id: null,
        }),
      )
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.on('error', reject)
    server.listen(requestedPort, host, () => resolve())
  })

  const addr = server.address()
  const actualPort =
    typeof addr === 'object' && addr ? addr.port : requestedPort

  const info: DaemonInfo = {
    pid: process.pid,
    port: actualPort,
    host,
    startedAt: new Date().toISOString(),
    version: YOMI_VERSION,
  }

  try {
    const file = daemonInfoPath()
    const dir = dirname(file)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(file, JSON.stringify(info, null, 2), 'utf8')
  } catch (err: any) {
    log.warn('daemon.info_write_failed', { error: err?.message ?? String(err) })
  }

  const cleanup = () => {
    try {
      rmSync(daemonInfoPath())
    } catch {}
    try {
      server.close()
    } catch {}
  }

  process.once('SIGTERM', cleanup)
  process.once('SIGINT', cleanup)
  process.once('exit', cleanup)

  if (!options.quiet) {
    log.info('daemon.started', { port: actualPort, host, pid: process.pid })
  }

  return { server, port: actualPort, info }
}

export async function stopDaemon(): Promise<{
  stopped: boolean
  pid?: number
}> {
  let info = readDaemonInfo()
  if (!info) {
    // daemon.json missing: try to discover a running daemon via probe so we
    // can still stop/restart it after upgrades (daemon may predate daemon.json
    // or the file may have been cleaned up).
    info = await getRunningDaemon()
  }
  if (!info) {
    return { stopped: false }
  }

  const pid = info.pid
  if (!pid || pid <= 0) {
    return { stopped: false }
  }

  try {
    process.kill(pid, 'SIGTERM')
    const start = Date.now()
    while (Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        process.kill(pid, 0)
      } catch {
        try {
          rmSync(daemonInfoPath())
        } catch {}
        return { stopped: true, pid }
      }
    }
    // Force kill if graceful exit timed out
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
    try {
      rmSync(daemonInfoPath())
    } catch {}
    return { stopped: true, pid }
  } catch {
    try {
      rmSync(daemonInfoPath())
    } catch {}
    return { stopped: false }
  }
}

/**
 * Start the daemon in a detached background process using the current runtime
 * and entrypoint, then wait until it is healthy. Used for automatic restarts
 * after package updates so users do not have to run `yomi daemon restart`.
 */
export async function startDaemonInBackground(
  options: { port?: number } = {},
): Promise<DaemonInfo | null> {
  const port = options.port
  const entry = process.argv[1]
  if (!entry) {
    return null
  }
  const child = spawn(
    process.execPath,
    [
      entry,
      'daemon',
      'start',
      '--foreground',
      ...(port ? ['--port', String(port)] : []),
    ],
    {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    },
  )
  child.unref()

  let running: DaemonInfo | null = null
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100))
    running = await getRunningDaemon()
    if (running) {
      break
    }
  }
  return running
}

/**
 * Ensure the running daemon (if any) matches this installed Yomi version.
 * When a stale daemon is detected, restart it automatically and transparently.
 */
export async function ensureDaemonUpToDate(): Promise<DaemonInfo | null> {
  const daemon = await getRunningDaemon()
  if (!daemon) {
    return null
  }
  if (!daemon.version || daemon.version === YOMI_VERSION) {
    return daemon
  }
  if (compareVersions(YOMI_VERSION, daemon.version) <= 0) {
    return daemon
  }

  log.info('daemon.auto_restart', {
    from: daemon.version,
    to: YOMI_VERSION,
    port: daemon.port,
  })
  await stopDaemon()
  await new Promise((r) => setTimeout(r, 300))
  const restarted = await startDaemonInBackground({ port: daemon.port })
  if (restarted) {
    log.info('daemon.auto_restarted', {
      version: restarted.version,
      pid: restarted.pid,
      port: restarted.port,
    })
  } else {
    log.warn('daemon.auto_restart_failed', {
      from: daemon.version,
      to: YOMI_VERSION,
    })
  }
  return restarted
}

export async function proxyStdioToDaemon(info: DaemonInfo): Promise<void> {
  const daemonUrl = `http://${info.host}:${info.port}/mcp`
  const readBuffer = new ReadBuffer()

  process.stdin.on('data', (chunk) => {
    readBuffer.append(chunk)
    while (true) {
      let message: any
      try {
        message = readBuffer.readMessage()
      } catch (err: any) {
        log.error('proxy.buffer_error', { error: err?.message ?? String(err) })
        break
      }
      if (!message) break

      const body = serializeMessage(message)
      fetch(daemonUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
      })
        .then(async (res) => {
          const text = await res.text()
          const lines = text.split('\n')
          let handled = false
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              const data = line.slice(6).trim()
              if (data) {
                process.stdout.write(`${data}\n`)
                handled = true
              }
            }
          }
          if (!handled && text.trim()) {
            process.stdout.write(`${text.trim()}\n`)
          }
        })
        .catch((error: any) => {
          if (message.id !== undefined && message.id !== null) {
            const errResp = {
              jsonrpc: '2.0',
              id: message.id,
              error: {
                code: -32000,
                message: `Failed to forward request to Yomi daemon: ${error?.message ?? String(error)}`,
              },
            }
            process.stdout.write(`${JSON.stringify(errResp)}\n`)
          }
        })
    }
  })

  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve)
    process.stdin.on('close', resolve)
  })
}
