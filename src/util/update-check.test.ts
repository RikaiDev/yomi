import { expect, test } from 'bun:test'
import { YOMI_VERSION } from '../version.js'
import {
  checkForUpdate,
  compareVersions,
  updateNotice,
} from './update-check.js'

test('compareVersions orders by numeric core, not string order', () => {
  expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
  expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
  expect(compareVersions('0.4.0', '0.4.0')).toBe(0)
  expect(compareVersions('0.4.0', '0.4.1')).toBeLessThan(0)
})

test('a pre-release of the same core version is not "behind"', () => {
  // Otherwise every local pre-release build would nag about an update to the
  // release it is ahead of.
  expect(compareVersions('0.5.0', '0.5.0-rc.1')).toBe(0)
  expect(compareVersions('v0.5.0', '0.5.0')).toBe(0)
})

test('the notice names the running version and how to update', () => {
  const notice = updateNotice('9.9.9')
  expect(notice).toContain(YOMI_VERSION)
  expect(notice).toContain('9.9.9')
  expect(notice).toContain('bun add -g @rikaidev/yomi@latest')
  expect(notice).toContain('npm install -g @rikaidev/yomi@latest')
  expect(notice).toContain('restarts automatically')
  expect(notice).toContain('no manual `yomi daemon restart`')
  expect(notice).not.toContain('or reinstall the package')
})

test('an mcpb install is told to download a bundle, not to run npx', () => {
  process.env.YOMI_DISTRIBUTION = 'mcpb'
  try {
    const notice = updateNotice('9.9.9')
    expect(notice).toContain('.mcpb')
    expect(notice).toContain('releases/latest')
    expect(notice).not.toContain('npx')
  } finally {
    delete process.env.YOMI_DISTRIBUTION
  }
})

test('the opt-out skips the request entirely', async () => {
  process.env.YOMI_NO_UPDATE_CHECK = '1'
  const originalFetch = globalThis.fetch
  let called = false
  globalThis.fetch = (async () => {
    called = true
    throw new Error('the opt-out must not reach the network')
  }) as typeof fetch
  try {
    expect(await checkForUpdate()).toBeNull()
    expect(called).toBe(false)
  } finally {
    globalThis.fetch = originalFetch
    delete process.env.YOMI_NO_UPDATE_CHECK
  }
})

test('a registry failure is silent, never a startup failure', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    throw new Error('offline')
  }) as typeof fetch
  try {
    expect(await checkForUpdate()).toBeNull()
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a newer published version produces a notice, an older one does not', async () => {
  const originalFetch = globalThis.fetch
  const reply = (version: string) =>
    (async () =>
      new Response(JSON.stringify({ version }), {
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
  try {
    globalThis.fetch = reply('99.0.0')
    expect(await checkForUpdate()).toContain('UPDATE AVAILABLE')
    globalThis.fetch = reply('0.0.1')
    expect(await checkForUpdate()).toBeNull()
    globalThis.fetch = reply(YOMI_VERSION)
    expect(await checkForUpdate()).toBeNull()
  } finally {
    globalThis.fetch = originalFetch
  }
})
