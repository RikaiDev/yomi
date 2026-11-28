#!/usr/bin/env node
/**
 * Installed-artifact MCP smoke test.
 *
 * Starts the packaged server twice: once pinned to the stateless 2026-07-28
 * protocol and once through the legacy initialize flow. Each connection lists
 * every tool and calls get_scope_policy so the probe reaches Yomi application
 * code and its SQLite boundary, not merely the SDK shell.
 */

import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = process.argv[2]
if (!entry) {
  console.error('usage: smoke-mcp.mjs <path-to-run.mjs>')
  process.exit(2)
}

/**
 * Every probe runs against a throwaway data directory AND with the Keychain
 * backend disabled (`YOMI_NO_KEYCHAIN`). Both are required: the Keychain is
 * machine-global and ignores YOMI_DATA_DIR, so on macOS a data-dir-only
 * redirect still restores the developer's live LINE session — and the `login`
 * probe below would then act on a REAL account, since a stored login
 * certificate is enough to start a device sign-in.
 */
const dataDir = mkdtempSync(join(tmpdir(), 'yomi-smoke-'))
const dbPath = join(dataDir, 'index.db')

/**
 * Verify one protocol era against a fresh packaged-server process.
 *
 * @param {'modern' | 'legacy'} expectedEra
 * @param {boolean} supportsApps
 */
async function verifyEra(expectedEra, supportsApps = false) {
  const client = new Client(
    {
      name: `install-smoke-${expectedEra}${supportsApps ? '-apps' : ''}`,
      version: '0',
    },
    {
      capabilities: supportsApps
        ? {
            extensions: {
              'io.modelcontextprotocol/ui': {
                mimeTypes: ['text/html;profile=mcp-app'],
              },
            },
          }
        : {},
      versionNegotiation:
        expectedEra === 'modern'
          ? { mode: { pin: '2026-07-28' } }
          : { mode: 'legacy' },
    },
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, 'serve'],
    env: {
      ...process.env,
      YOMI_DATA_DIR: dataDir,
      YOMI_INDEX_DB_PATH: dbPath,
      YOMI_NO_KEYCHAIN: '1',
      // Keep the probes hermetic: no npm-registry round trip at startup, and
      // never proxy to a daemon that happens to run on this machine — these
      // probes certify the standalone artifact's own protocol negotiation.
      YOMI_STANDALONE: '1',
      YOMI_NO_UPDATE_CHECK: '1',
    },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await client.connect(transport)
    const actualEra = client.getProtocolEra()
    if (actualEra !== expectedEra) {
      throw new Error(`negotiated ${actualEra}; expected ${expectedEra}`)
    }

    const toolList = await client.listTools()
    const { tools } = toolList
    if (tools.length !== 51) {
      throw new Error(`tools/list returned ${tools.length} tools; expected 51`)
    }
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
      throw new Error('tools/list returned duplicate tool names')
    }
    if (
      expectedEra === 'modern' &&
      (toolList.ttlMs !== 0 || toolList.cacheScope !== 'private')
    ) {
      throw new Error(
        `modern tools/list cache fields are invalid: ${JSON.stringify(toolList)}`,
      )
    }
    const invalidTool = tools.find(
      (tool) =>
        !tool.name ||
        tool.inputSchema?.type !== 'object' ||
        !tool.inputSchema.properties,
    )
    if (invalidTool) {
      throw new Error(`invalid tool schema: ${JSON.stringify(invalidTool)}`)
    }

    const loginTool = tools.find((tool) => tool.name === 'login')
    const resources = await client.listResources()
    if (resources.resources.length !== 1) {
      throw new Error(
        `resources/list returned ${resources.resources.length}; expected 1`,
      )
    }
    if (loginTool?._meta?.ui?.resourceUri !== 'ui://yomi/login') {
      throw new Error('login tool is missing its MCP Apps resource link')
    }
    const resource = await client.readResource({ uri: 'ui://yomi/login' })
    const html = resource.contents[0]
    if (
      html?.mimeType !== 'text/html;profile=mcp-app' ||
      !('text' in html) ||
      !html.text.includes('ui/initialize')
    ) {
      throw new Error(`invalid MCP Apps resource: ${JSON.stringify(html)}`)
    }
    try {
      await client.readResource({ uri: 'ui://yomi/not-found' })
      throw new Error('unknown resources/read unexpectedly succeeded')
    } catch (error) {
      if (error.code !== -32602) {
        throw new Error(
          `unknown resource returned ${error.code}; expected -32602`,
        )
      }
    }

    const result = await client.callTool({
      name: 'get_scope_policy',
      arguments: {},
    })
    const text = result.content?.find((block) => block.type === 'text')?.text
    if (result.isError || !text) {
      throw new Error(
        `get_scope_policy failed: ${JSON.stringify(result)}`,
      )
    }
    return `${expectedEra}${supportsApps ? '+apps' : ''} ${tools.length} tools / ${text.length} policy bytes`
  } catch (error) {
    const detail = stderr ? `\n--- server stderr ---\n${stderr}` : ''
    throw new Error(`${expectedEra} smoke failed: ${error.message}${detail}`, {
      cause: error,
    })
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * Drive the 2026-07-28 multi-round-trip `login` flow end to end without
 * touching LINE: answer the pre-flight elicitation with "the setting is off",
 * which is exactly the case that must never start a login.
 *
 * The client auto-fulfils `input_required` results through its own
 * `elicitation/create` handler and retries the call, so one `callTool` here
 * covers round 1 (server asks) and round 2 (server answers the retry).
 *
 * @returns A one-line summary for the OK log.
 */
async function verifyMrtrLogin() {
  const client = new Client(
    { name: 'install-smoke-mrtr', version: '0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  )
  const prompts = []
  client.setRequestHandler('elicitation/create', async (request) => {
    prompts.push(request.params)
    return { action: 'accept', content: { primaryDeviceLogin: 'not_enabled' } }
  })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, 'serve'],
    env: {
      ...process.env,
      YOMI_DATA_DIR: dataDir,
      YOMI_INDEX_DB_PATH: dbPath,
      YOMI_NO_KEYCHAIN: '1',
      // Keep the probes hermetic: no npm-registry round trip at startup, and
      // never proxy to a daemon that happens to run on this machine — these
      // probes certify the standalone artifact's own protocol negotiation.
      YOMI_STANDALONE: '1',
      YOMI_NO_UPDATE_CHECK: '1',
    },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await client.connect(transport)
    const result = await client.callTool({ name: 'login', arguments: {} })
    if (prompts.length !== 1) {
      throw new Error(
        `login asked for ${prompts.length} elicitations; expected 1 (the pre-flight form)`,
      )
    }
    const [preflight] = prompts
    if (!preflight.requestedSchema?.properties?.primaryDeviceLogin) {
      throw new Error(
        `pre-flight form is missing the prerequisite question: ${JSON.stringify(preflight)}`,
      )
    }
    if (!preflight.message?.includes('允許自其他裝置登入')) {
      throw new Error(`pre-flight message does not name the setting: ${preflight.message}`)
    }
    const text = result.content?.find((block) => block.type === 'text')?.text
    if (result.isError || !text?.includes('允許自其他裝置登入')) {
      throw new Error(
        `login did not return the enabling steps: ${JSON.stringify(result)}`,
      )
    }
    if (!text.includes('Login was not started')) {
      throw new Error(`login started despite the prerequisite being off: ${text}`)
    }
    return `mrtr login gated in ${prompts.length} round / ${text.length} guidance bytes`
  } catch (error) {
    const detail = stderr ? `\n--- server stderr ---\n${stderr}` : ''
    throw new Error(`mrtr login smoke failed: ${error.message}${detail}`, {
      cause: error,
    })
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * Reserve a free TCP port for the daemon-backed probe. The daemon's data dir
 * is already isolated; an isolated port keeps this probe from touching a real
 * daemon running on the developer's machine.
 *
 * @returns {Promise<number>} An available port number.
 */
async function freePort() {
  const server = createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

/**
 * Certify the DEFAULT installed path: no daemon running, no YOMI_STANDALONE,
 * and a modern pinned client. The CLI must auto-start a daemon and the daemon
 * must serve the same login elicitation as the standalone artifact.
 *
 * @returns {Promise<string>} A one-line summary for the OK log.
 */
async function verifyDaemonAutoStart() {
  const port = await freePort()
  const daemonInfoPath = join(dataDir, 'daemon.json')
  if (existsSync(daemonInfoPath)) {
    throw new Error('daemon-backed probe started with a stale daemon.json')
  }
  const client = new Client(
    { name: 'install-smoke-daemon', version: '0' },
    {
      capabilities: { elicitation: { form: {} } },
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  )
  const prompts = []
  client.setRequestHandler('elicitation/create', async (request) => {
    prompts.push(request.params)
    return { action: 'accept', content: { primaryDeviceLogin: 'not_enabled' } }
  })
  const env = {
    ...process.env,
    YOMI_DATA_DIR: dataDir,
    YOMI_INDEX_DB_PATH: dbPath,
    YOMI_NO_KEYCHAIN: '1',
    YOMI_NO_UPDATE_CHECK: '1',
    YOMI_PORT: String(port),
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, 'serve'],
    env,
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (chunk) => {
    stderr += chunk
  })

  try {
    await client.connect(transport)
    if (client.getProtocolEra() !== 'modern') {
      throw new Error('daemon-backed client did not negotiate the modern era')
    }
    if (!existsSync(daemonInfoPath)) {
      throw new Error('the default CLI path did not auto-start a daemon')
    }
    const daemon = JSON.parse(readFileSync(daemonInfoPath, 'utf8'))
    if (!daemon.pid || daemon.pid <= 0) {
      throw new Error(`daemon.json has no live pid: ${JSON.stringify(daemon)}`)
    }
    if (!daemon.socketPath || !existsSync(daemon.socketPath)) {
      throw new Error(`daemon.json has no live socket: ${JSON.stringify(daemon)}`)
    }
    const tools = await client.listTools()
    if (!tools.tools.some((tool) => tool.name === 'search_contact')) {
      throw new Error('daemon-backed tools/list is missing search_contact')
    }
    const result = await client.callTool({ name: 'login', arguments: {} })
    if (prompts.length !== 1) {
      throw new Error(
        `daemon-backed login asked for ${prompts.length} elicitations; expected 1`,
      )
    }
    const text = result.content?.find((block) => block.type === 'text')?.text
    if (result.isError || !text?.includes('Login was not started')) {
      throw new Error(
        `daemon-backed login failed: ${JSON.stringify(result)}`,
      )
    }
    return `daemon auto-start on port ${port}, pid ${daemon.pid}, 1 elicitation`
  } catch (error) {
    const detail = stderr ? `\n--- server stderr ---\n${stderr}` : ''
    throw new Error(`daemon smoke failed: ${error.message}${detail}`, {
      cause: error,
    })
  } finally {
    await client.close().catch(() => {})
    await stopSmokeDaemon(port)
  }
}

async function stopSmokeDaemon(port) {
  const { spawn } = await import('node:child_process')
  const child = spawn(process.execPath, [entry, 'daemon', 'stop'], {
    env: {
      ...process.env,
      YOMI_DATA_DIR: dataDir,
      YOMI_INDEX_DB_PATH: dbPath,
      YOMI_NO_KEYCHAIN: '1',
      YOMI_NO_UPDATE_CHECK: '1',
      YOMI_PORT: String(port),
    },
    stdio: 'ignore',
  })
  await new Promise((resolve) => child.once('close', resolve))
}

try {
  const modern = await verifyEra('modern')
  const modernApps = await verifyEra('modern', true)
  const legacy = await verifyEra('legacy')
  const mrtr = await verifyMrtrLogin()
  const daemon = await verifyDaemonAutoStart()
  console.log(`OK: ${modern}; ${modernApps}; ${legacy}; ${mrtr}; ${daemon}`)
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  process.exit(1)
}
