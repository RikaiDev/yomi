/**
 * Yomi MCP Shared Daemon.
 *
 * Runs a single, persistent Yomi instance (holding one LINE session, one
 * Transformers embedding model, and one SQLite search index) as a background
 * daemon. Multiple AI clients (OpenCode, Minimax, Claude Code, Cursor, Agy)
 * share this daemon via HTTP/SSE or transparent stdio proxies, eliminating
 * redundant processes, memory duplication, and session race conditions.
 */

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
import { checkForUpdate } from '../util/update-check.js'
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
    startCapture(service, getDefaultEmbedder()).catch((error: any) => {
      log.error('capture.start_failed', {
        error: error?.message ?? String(error),
      })
    })
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
  const info = readDaemonInfo()
  if (!info) {
    return { stopped: false }
  }

  try {
    process.kill(info.pid, 'SIGTERM')
    const start = Date.now()
    while (Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 100))
      try {
        process.kill(info.pid, 0)
      } catch {
        try {
          rmSync(daemonInfoPath())
        } catch {}
        return { stopped: true, pid: info.pid }
      }
    }
    // Force kill if graceful exit timed out
    process.kill(info.pid, 'SIGKILL')
    try {
      rmSync(daemonInfoPath())
    } catch {}
    return { stopped: true, pid: info.pid }
  } catch {
    try {
      rmSync(daemonInfoPath())
    } catch {}
    return { stopped: false }
  }
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
