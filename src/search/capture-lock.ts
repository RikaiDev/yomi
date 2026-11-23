/**
 * Yomi capture lock — one writer for the shared index.
 *
 * Yomi can be running in more than one process at the same time: the shared
 * daemon (see ../mcp/daemon.ts), a standalone runtime, and whatever a client
 * spawns directly. Every one of them opened the same `search-index.db`, and
 * every one of them ran its own startup catch-up and its own live-flush
 * indexing against it. Two writers doing the same work means duplicated LINE
 * traffic, duplicated embedding work, and SQLite WAL contention — the index
 * is written with WAL mode, and a second writer checkpointing the same WAL
 * stalls the first.
 *
 * This lock makes the background work single-writer: the first process to
 * start capture owns the lock and does the catching-up, the live indexing and
 * the embedding backlog; later processes stand down and serve reads. The lock
 * is a file with the owner's pid and a heartbeat, so it survives a crash: a
 * lock whose owner is gone is taken over by the next process that asks.
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createCliLogger } from '../util/log.js'

const log = createCliLogger('Yomi')

/** A lock whose heartbeat is older than this is considered abandoned. */
const DEFAULT_STALE_MS = 60000
/** How often the owner refreshes the heartbeat. */
const HEARTBEAT_INTERVAL_MS = 15000

/** Contents of the lock file. */
interface LockPayload {
  pid: number
  startedAt: number
  heartbeatAt: number
}

/** A held capture lock. */
export interface CaptureLock {
  /** Refresh the heartbeat — call from the owner's periodic tick. */
  heartbeat(): void
  /** Release the lock (called on shutdown). */
  release(): void
}

function lockPath(): string {
  const override = process.env.YOMI_DATA_DIR
  const dir = override
    ? override
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'yomi')
      : join(
          process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'),
          'yomi',
        )
  return join(dir, 'capture.lock')
}

/**
 * Whether a process is still running.
 *
 * @param pid - Process id to test.
 * @returns True when the process exists.
 */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error: any) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM'
  }
}

function readLock(): LockPayload | null {
  try {
    const raw = readFileSync(lockPath(), 'utf8')
    const parsed = JSON.parse(raw) as LockPayload
    if (typeof parsed?.pid !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Try to become the single writer for the shared index.
 *
 * @param staleMs - A lock whose owner is gone or whose heartbeat is older
 *   than this is taken over. Defaults to 60s.
 * @returns The lock when acquired, null when another live process owns it.
 */
export function acquireCaptureLock(
  staleMs = DEFAULT_STALE_MS,
): CaptureLock | null {
  const path = lockPath()
  const existing = readLock()
  if (existing) {
    const fresh = Date.now() - existing.heartbeatAt < staleMs
    if (fresh && isAlive(existing.pid)) {
      log.info('capture.lock_held_elsewhere', { pid: existing.pid })
      return null
    }
    log.info('capture.lock_takeover', {
      previousPid: existing.pid,
      fresh,
    })
  }

  const payload: LockPayload = {
    pid: process.pid,
    startedAt: Date.now(),
    heartbeatAt: Date.now(),
  }
  try {
    writeFileSync(path, JSON.stringify(payload), { mode: 0o600 })
  } catch (error: any) {
    // A lock we cannot write is not a reason to stop capturing — the worst
    // case is two writers, which is where we started.
    log.warn('capture.lock_write_failed', {
      error: error?.message ?? String(error),
    })
    return null
  }

  const timer = setInterval(() => {
    try {
      writeFileSync(
        path,
        JSON.stringify({ ...payload, heartbeatAt: Date.now() }),
        { mode: 0o600 },
      )
    } catch {
      // A failed heartbeat lets the next process take over — acceptable.
    }
  }, HEARTBEAT_INTERVAL_MS)
  timer.unref?.()

  const release = (): void => {
    clearInterval(timer)
    try {
      const current = readLock()
      if (!current || current.pid === process.pid) {
        unlinkSync(path)
      }
    } catch {
      // The lock file is advisory; failing to remove it only means a later
      // process waits for the heartbeat to go stale.
    }
  }

  process.once('exit', release)
  log.info('capture.lock_acquired', { pid: process.pid, path })
  return {
    heartbeat: () => {},
    release,
  }
}
