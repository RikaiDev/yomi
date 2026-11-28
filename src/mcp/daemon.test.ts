/**
 * Unit tests for Yomi Shared MCP Daemon.
 */

import { describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  Client,
  type JSONRPCMessage,
  type Transport,
} from '@modelcontextprotocol/client'
import { YOMI_VERSION } from '../version.js'
import {
  acquireDaemonLock,
  computeDistBuildId,
  type DaemonInfo,
  daemonInfoPath,
  daemonLockPath,
  daemonSocketPath,
  isDaemonHealthy,
  readDaemonInfo,
  releaseDaemonLock,
  startDaemonServer,
  stopDaemon,
} from './daemon.js'

/** Minimal Transport over a Unix socket for the stdio-serving daemon test. */
class SocketTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private buffer = ''
  constructor(private socket: Socket) {}

  async start(): Promise<void> {
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk
      while (true) {
        const index = this.buffer.indexOf('\n')
        if (index < 0) break
        const line = this.buffer.slice(0, index)
        this.buffer = this.buffer.slice(index + 1)
        if (!line.trim()) continue
        this.onmessage?.(JSON.parse(line) as JSONRPCMessage)
      }
    })
    this.socket.on('close', () => this.onclose?.())
    this.socket.on('error', (error) => this.onerror?.(error))
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.socket.write(`${JSON.stringify(message)}\n`)
  }

  async close(): Promise<void> {
    this.socket.destroy()
  }
}

// Hermetic data dir: these tests start real daemons, locks and daemon.json —
// they must never touch (or kill!) the machine's actual running daemon.
process.env.YOMI_DATA_DIR = mkdtempSync(join(tmpdir(), 'yomi-test-data-'))

describe('Yomi MCP Daemon', () => {
  test('daemonInfoPath resolves to yomi data directory daemon.json', () => {
    const path = daemonInfoPath()
    expect(path).toContain('daemon.json')
  })

  test('daemonLockPath resolves to yomi data directory daemon.lock', () => {
    expect(daemonLockPath()).toContain('daemon.lock')
  })

  test('acquireDaemonLock refuses while this process already holds it', () => {
    const first = acquireDaemonLock()
    expect(first.locked).toBe(true)
    try {
      const second = acquireDaemonLock()
      expect(second.locked).toBe(false)
      if (!second.locked) {
        expect(second.holderPid).toBe(process.pid)
      }
    } finally {
      releaseDaemonLock(first.lock)
    }
    const third = acquireDaemonLock()
    expect(third.locked).toBe(true)
    releaseDaemonLock(third.lock)
  })

  test('acquireDaemonLock recovers a stale lock from a dead holder', () => {
    const dir = dirname(daemonLockPath())
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(daemonLockPath(), '99999999', 'utf8')
    const acquired = acquireDaemonLock()
    expect(acquired.locked).toBe(true)
    releaseDaemonLock(acquired.lock)
  })

  test('acquireDaemonLock refuses a live foreign holder', () => {
    const dir = dirname(daemonLockPath())
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(daemonLockPath(), String(process.ppid), 'utf8')
    const acquired = acquireDaemonLock()
    expect(acquired.locked).toBe(false)
    if (!acquired.locked) {
      expect(acquired.holderPid).toBe(process.ppid)
    }
    rmSync(daemonLockPath())
  })

  test('computeDistBuildId is stable and reacts to content changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-dist-'))
    try {
      writeFileSync(join(dir, 'a.js'), 'export const a = 1', 'utf8')
      mkdirSync(join(dir, 'sub'), { recursive: true })
      writeFileSync(join(dir, 'sub', 'b.js'), 'export const b = 2', 'utf8')

      const first = computeDistBuildId(dir, { quietMs: 0 })
      const again = computeDistBuildId(dir, { quietMs: 0 })
      expect(first).toBeTruthy()
      expect(first).toBe(again)

      writeFileSync(join(dir, 'sub', 'b.js'), 'export const b = 3', 'utf8')
      const changed = computeDistBuildId(dir, { quietMs: 0 })
      expect(changed).toBeTruthy()
      expect(changed).not.toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('computeDistBuildId stays null inside the write quiet window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'yomi-dist-'))
    try {
      writeFileSync(join(dir, 'a.js'), 'export const a = 1', 'utf8')
      // Written just now — inside the default quiet window: a build in flight.
      expect(computeDistBuildId(dir)).toBeNull()
      expect(computeDistBuildId(dir, { quietMs: 0 })).toBeTruthy()
      expect(computeDistBuildId(join(dir, 'missing'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('readDaemonInfo detects and cleans up stale daemon PID', () => {
    const path = daemonInfoPath()
    const fakeInfo: DaemonInfo = {
      pid: 99999999, // non-existent PID
      port: 3333,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      version: '0.6.2',
    }
    const dir = dirname(path)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }
    writeFileSync(path, JSON.stringify(fakeInfo), 'utf8')
    expect(existsSync(path)).toBe(true)

    const info = readDaemonInfo()
    expect(info).toBeNull()
    expect(existsSync(path)).toBe(false)
  })

  test('isDaemonHealthy returns false for unreachable daemon', async () => {
    const unreachableInfo: DaemonInfo = {
      pid: process.pid,
      port: 59999,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      version: '0.6.2',
    }
    const healthy = await isDaemonHealthy(unreachableInfo)
    expect(healthy).toBe(false)
  })

  test('startDaemonServer starts HTTP and MCP endpoints on ephemeral port', async () => {
    // Avoid connecting to live LINE in unit test by passing standalone options
    process.env.YOMI_NO_KEYCHAIN = '1'
    process.env.YOMI_NO_UPDATE_CHECK = '1'

    const { server, port, info } = await startDaemonServer({
      port: 0, // ephemeral port
      quiet: true,
    })

    try {
      expect(port).toBeGreaterThan(0)
      expect(info.port).toBe(port)
      expect(info.pid).toBe(process.pid)

      // Test /health endpoint
      const healthRes = await fetch(`http://127.0.0.1:${port}/health`)
      expect(healthRes.status).toBe(200)
      const healthJson = (await healthRes.json()) as any
      expect(healthJson.ok).toBe(true)
      expect(healthJson.pid).toBe(process.pid)
      expect(healthJson.version).toBeDefined()

      // Test modern MCP initialize request over HTTP
      const mcpRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2026-07-28',
            capabilities: {},
            clientInfo: { name: 'test-client', version: '1.0' },
          },
        }),
      })

      expect(mcpRes.status).toBe(200)
      const mcpText = await mcpRes.text()
      expect(mcpText).toContain('"jsonrpc":"2.0"')
      expect(mcpText).toContain('"serverInfo"')
      expect(mcpText).toContain('"name":"yomi"')

      // Test tools/list request over HTTP
      const toolsRes = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      })

      expect(toolsRes.status).toBe(200)
      const toolsText = await toolsRes.text()
      expect(toolsText).toContain('list_conversations')
      expect(toolsText).toContain('send_message')
    } finally {
      server.close()
      try {
        rmSync(daemonInfoPath())
      } catch {}
      try {
        rmSync(daemonLockPath())
      } catch {}
    }
  })

  test('daemonSocketPath lives in the configured data dir', () => {
    expect(daemonSocketPath()).toBe(join(daemonInfoPath(), '..', 'daemon.sock'))
  })

  test('daemon health advertises the stdio socket and the socket serves MCP', async () => {
    process.env.YOMI_NO_KEYCHAIN = '1'
    process.env.YOMI_NO_UPDATE_CHECK = '1'

    const { server, port } = await startDaemonServer({ port: 0, quiet: true })
    try {
      const socketPath = daemonSocketPath()
      expect(existsSync(socketPath)).toBe(true)
      const health = (await (
        await fetch(`http://127.0.0.1:${port}/health`)
      ).json()) as any
      expect(health.socketPath).toBe(socketPath)

      const client = new Client(
        { name: 'yomi-daemon-socket-test', version: '0' },
        { versionNegotiation: { mode: { pin: '2026-07-28' } } },
      )
      const socket = createConnection(socketPath)
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve)
        socket.once('error', reject)
      })
      try {
        await client.connect(new SocketTransport(socket))
        expect(client.getServerVersion()?.version).toBe(YOMI_VERSION)
        const tools = await client.listTools()
        expect(tools.tools.map((tool) => tool.name)).toContain('search_contact')
        expect(tools.tools.map((tool) => tool.name)).toContain('add_contact')
      } finally {
        await client.close()
      }
    } finally {
      server.close()
      try {
        rmSync(daemonSocketPath())
      } catch {}
      try {
        rmSync(daemonInfoPath())
      } catch {}
      try {
        rmSync(daemonLockPath())
      } catch {}
    }
  })

  test('startDaemonServer refuses a second daemon in the same process', async () => {
    process.env.YOMI_NO_KEYCHAIN = '1'
    process.env.YOMI_NO_UPDATE_CHECK = '1'

    const { server } = await startDaemonServer({ port: 0, quiet: true })
    try {
      await expect(startDaemonServer({ port: 0, quiet: true })).rejects.toThrow(
        /already running/,
      )
    } finally {
      server.close()
      try {
        rmSync(daemonLockPath())
      } catch {}
      try {
        rmSync(daemonInfoPath())
      } catch {}
    }
  })

  test('startDaemonServer records distPath and buildId for rebuild detection', async () => {
    process.env.YOMI_NO_KEYCHAIN = '1'
    process.env.YOMI_NO_UPDATE_CHECK = '1'

    const { server } = await startDaemonServer({ port: 0, quiet: true })
    try {
      const info = JSON.parse(
        readFileSync(daemonInfoPath(), 'utf8'),
      ) as DaemonInfo
      expect(info.distPath).toBeTruthy()
      expect(info.distPath).not.toBe(process.cwd())
      expect(info.buildId).toBeTruthy()
      // The daemon snapshots with no quiet window (it just imported the build).
      expect(info.buildId).toBe(
        computeDistBuildId(info.distPath!, { quietMs: 0 }),
      )
    } finally {
      server.close()
      try {
        rmSync(daemonLockPath())
      } catch {}
      try {
        rmSync(daemonInfoPath())
      } catch {}
    }
  })

  test('stopDaemon returns stopped: false when no daemon is running', async () => {
    try {
      rmSync(daemonInfoPath())
    } catch {}
    const originalPort = process.env.YOMI_PORT
    process.env.YOMI_PORT = '59998'
    try {
      const res = await stopDaemon()
      expect(res.stopped).toBe(false)
    } finally {
      if (originalPort === undefined) {
        delete process.env.YOMI_PORT
      } else {
        process.env.YOMI_PORT = originalPort
      }
    }
  })
})
