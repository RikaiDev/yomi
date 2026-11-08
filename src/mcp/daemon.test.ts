/**
 * Unit tests for Yomi Shared MCP Daemon.
 */

import { describe, expect, test } from 'bun:test'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import {
  type DaemonInfo,
  daemonInfoPath,
  isDaemonHealthy,
  readDaemonInfo,
  startDaemonServer,
  stopDaemon,
} from './daemon.js'

describe('Yomi MCP Daemon', () => {
  test('daemonInfoPath resolves to yomi data directory daemon.json', () => {
    const path = daemonInfoPath()
    expect(path).toContain('daemon.json')
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
    }
  })

  test('stopDaemon returns stopped: false when no daemon is running', async () => {
    try {
      rmSync(daemonInfoPath())
    } catch {}
    const res = await stopDaemon()
    expect(res.stopped).toBe(false)
  })
})
