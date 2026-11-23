import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The lock lives in Yomi's data directory, which is read per call — so each
 * test can point it at its own throwaway directory.
 */
function withTempDataDir<T>(fn: () => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'yomi-lock-test-'))
  const previous = process.env.YOMI_DATA_DIR
  process.env.YOMI_DATA_DIR = dir
  try {
    return fn()
  } finally {
    if (previous === undefined) {
      delete process.env.YOMI_DATA_DIR
    } else {
      process.env.YOMI_DATA_DIR = previous
    }
  }
}

test('a second writer stands down while the first holds the lock', async () => {
  const { acquireCaptureLock } = await import('./capture-lock.js')
  withTempDataDir(() => {
    const first = acquireCaptureLock()
    expect(first).not.toBeNull()
    const second = acquireCaptureLock()
    expect(second).toBeNull()
    first?.release()
    const third = acquireCaptureLock()
    expect(third).not.toBeNull()
    third?.release()
  })
})

test('the embedding worker defers its tick while a foreground request is in flight', async () => {
  const { isForegroundBusy, markForegroundActivity } = await import(
    './embedding-worker.js'
  )
  expect(isForegroundBusy(5000)).toBe(false)
  markForegroundActivity()
  expect(isForegroundBusy(5000)).toBe(true)
  // With a zero grace window the request counts as finished already.
  expect(isForegroundBusy(0)).toBe(false)
})
