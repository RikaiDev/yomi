/**
 * Yomi background embedding worker — the idle-resource half of the index.
 *
 * The search index stores every message as text (FTS5/bigram), so keyword
 * search is useful the instant a message is collected. Semantic search needs
 * a vector per message, and producing those vectors is expensive: the local
 * ONNX encoder runs on CPU, one forward pass per batch of messages. Doing
 * that work inside a foreground tool call is what used to push
 * `collect_messages` and `search_messages` past the MCP request timeout —
 * a request was spending minutes on a backlog of thousands of unembedded
 * messages it did not need in order to answer the question in front of it.
 *
 * This worker takes that work off the request path:
 *   - it runs on a timer, in small bounded batches;
 *   - it yields to the foreground — a tick is skipped while a foreground MCP
 *     request is in flight (see markForegroundActivity), so embedding only
 *     happens while the process is otherwise idle;
 *   - it is restartable — coverage is derived from the index itself (rows
 *     missing a vector for the current model), not from an in-memory cursor,
 *     so a crash, a kill, or a model failure resumes exactly where it left
 *     off instead of redoing or skipping work.
 *
 * The worker never blocks a caller: it is fire-and-forget, and every failure
 * is logged and retried later with backoff.
 */

import { createCliLogger } from '../util/log.js'
import { embedMissingBatch } from './collector.js'
import type { Embedder } from './embedder.js'
import { getMessagesMissingEmbedding } from './store.js'

const log = createCliLogger('Yomi')

/** Messages embedded per tick. Small enough to stay a background task. */
const DEFAULT_BATCH = 32
/** Delay between ticks. */
const DEFAULT_INTERVAL_MS = 15000
/** How long after a foreground request the process is still considered busy. */
const DEFAULT_BUSY_GRACE_MS = 5000
/** Backoff ceiling after consecutive failures (model missing, disk error). */
const MAX_BACKOFF_MS = 300000

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw)
  return fallback
}

/**
 * Timestamp of the last foreground MCP request in this process. The worker
 * skips its tick while this is recent, so embedding uses only what the
 * process would otherwise be idle on.
 */
let lastForegroundActivity = 0

/**
 * Record that a foreground MCP request just started. Called from the
 * tools/call handler (see ../mcp/server.ts).
 */
export function markForegroundActivity(): void {
  lastForegroundActivity = Date.now()
}

/**
 * Whether a foreground request is in flight (or finished moments ago).
 *
 * @param graceMs - How long to treat the process as busy after the last
 *   foreground request. Defaults to 5s.
 * @returns True when the worker should stand down this tick.
 */
export function isForegroundBusy(graceMs = DEFAULT_BUSY_GRACE_MS): boolean {
  if (lastForegroundActivity === 0) return false
  return Date.now() - lastForegroundActivity < graceMs
}

/** Options for the background embedding worker. */
export interface EmbeddingWorkerOptions {
  /** Messages embedded per tick (default 32). */
  batchSize?: number
  /** Delay between ticks in milliseconds (default 15000). */
  intervalMs?: number
  /** How long the process stays "busy" after a foreground request (default 5000ms). */
  busyGraceMs?: number
}

/** Handle for a running worker. */
export interface EmbeddingWorkerHandle {
  /** Stop the worker and release its timer. */
  stop(): void
  /** Run one tick immediately (used after new messages are indexed). */
  nudge(): void
}

/**
 * Start the background embedding worker.
 *
 * Does nothing when YOMI_EMBED_WORKER=0 — the escape hatch for a machine
 * where semantic vectors are not wanted at all.
 *
 * @param embedder - Embedder used to produce vectors.
 * @param options - Batch size, interval, and busy grace overrides.
 * @returns Handle to stop or nudge the worker.
 */
export function startEmbeddingWorker(
  embedder: Embedder,
  options: EmbeddingWorkerOptions = {},
): EmbeddingWorkerHandle {
  if (process.env.YOMI_EMBED_WORKER === '0') {
    log.info('embedder.worker_disabled', {})
    return { stop: () => {}, nudge: () => {} }
  }

  const batchSize =
    options.batchSize ?? envInt('YOMI_EMBED_WORKER_BATCH', DEFAULT_BATCH)
  const intervalMs =
    options.intervalMs ??
    envInt('YOMI_EMBED_WORKER_INTERVAL_MS', DEFAULT_INTERVAL_MS)
  const busyGraceMs =
    options.busyGraceMs ??
    envInt('YOMI_EMBED_WORKER_BUSY_GRACE_MS', DEFAULT_BUSY_GRACE_MS)

  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let backoffMs = intervalMs
  let consecutiveFailures = 0
  let running = false

  const tick = async (): Promise<void> => {
    if (stopped) return
    if (running) return
    if (isForegroundBusy(busyGraceMs)) {
      log.info('embedder.worker_deferred', { reason: 'foreground_busy' })
      schedule()
      return
    }
    running = true
    try {
      const pending = getMessagesMissingEmbedding(embedder.modelLabel, 1).length
      if (pending === 0) {
        consecutiveFailures = 0
        backoffMs = intervalMs
        schedule()
        return
      }
      const embedded = await embedMissingBatch(embedder, batchSize)
      consecutiveFailures = 0
      backoffMs = intervalMs
      if (embedded > 0) {
        log.info('embedder.worker_progress', { embedded, batchSize })
      }
    } catch (error: any) {
      consecutiveFailures += 1
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
      log.warn('embedder.worker_failed', {
        error: error?.message ?? String(error),
        consecutiveFailures,
        retryInMs: backoffMs,
      })
    } finally {
      running = false
      schedule()
    }
  }

  const schedule = (): void => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick()
    }, backoffMs)
    timer.unref?.()
  }

  schedule()
  log.info('embedder.worker_started', {
    batchSize,
    intervalMs,
    busyGraceMs,
    model: embedder.modelLabel,
  })

  return {
    stop: () => {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    nudge: () => {
      if (stopped) return
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      backoffMs = intervalMs
      schedule()
    },
  }
}
