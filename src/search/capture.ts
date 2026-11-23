/**
 * Yomi continuous capture — the in-process, silent, denylist-gated sync loop.
 *
 * Unlike collect_messages (explicit, one-shot, caller-invoked), this runs for
 * the life of the MCP process: LINE's stdio MCP server is spawned once by the
 * client and lives as long as that client, so a background loop here keeps the
 * local search index current while the user is actually using the app.
 *
 * Two mechanisms:
 *   - Startup catch-up: one collectMessages() over the conversations that
 *     moved since the last run, to fill the gap for anything that arrived
 *     while the process was down. Idempotent (upsert), denylist-gated inside
 *     collectMessages, and bounded by a wall-clock budget.
 *   - Live loop: LINE's startPolling long-polls SYNC4; on each new message we
 *     index just the affected chat via collectMessages({ chatIds }).
 *
 * A third, separate mechanism lives in ./embedding-worker.ts: the semantic
 * vectors for already-indexed messages are produced by a background worker
 * in small idle batches, so neither the catch-up nor a foreground tool call
 * ever pays for the whole embedding backlog.
 *
 * Only one process writes the index at a time (see ./capture-lock.ts); the
 * others stand down so two instances never duplicate the work or race on
 * the same SQLite file.
 *
 * This is SILENT: SYNC4 sync never sends a read receipt, so capture never marks
 * anything read. Excluded (denylisted) chats are dropped inside collectMessages,
 * so they are never fetched or indexed. Sending/read-receipts are never
 * triggered here.
 */

import { listBoxesByRecency } from '../line/core/message-box-recency.js'
import type { LineProtocolService } from '../line/core/service.js'
import { createCliLogger } from '../util/log.js'
import { acquireCaptureLock } from './capture-lock.js'
import { collectMessages } from './collector.js'
import type { Embedder } from './embedder.js'
import { startEmbeddingWorker } from './embedding-worker.js'
import {
  deriveAllEvidence,
  deriveEvidenceForChats,
  FULL_REDERIVE_INTERVAL_MS,
} from './persona-index.js'
import { SqliteUnavailableError } from './sqlite.js'
import { getMaxIndexedMessageTimeByChat, saveCaptureState } from './store.js'

const log = createCliLogger('Yomi')

/** Milliseconds to batch new-message signals before indexing affected chats. */
const FLUSH_DEBOUNCE_MS = 2000
/** Recent messages to (re)index per affected chat on a live flush. */
const LIVE_PER_CHAT = 30
/** Messages fetched per chat during the startup catch-up. */
const CATCHUP_PER_CHAT = 50
/** Wall-clock budget for the startup catch-up sweep. */
const CATCHUP_BUDGET_MS = 30000

/**
 * Chats that moved since the last time we indexed them.
 *
 * A full sweep re-reads every conversation on every process start, which is
 * pure waste for the chats that have not changed since the last run. LINE
 * tells us the newest activity per chat (see listBoxesByRecency) and the
 * index tells us the newest message we already stored for that chat, so the
 * difference is exactly the set of chats worth re-reading.
 *
 * @param service - Resumed LineProtocolService.
 * @returns Chat MIDs whose LINE activity is newer than our last indexed
 *   message, most recently active first.
 */
async function selectChatsNeedingCatchup(
  service: LineProtocolService,
): Promise<string[]> {
  const boxes = await listBoxesByRecency(service, { withUnreadCount: false })
  const lastIndexed = getMaxIndexedMessageTimeByChat()
  const targets: { id: string; activity: number }[] = []
  for (const box of boxes) {
    const id = box?.id
    if (!id) continue
    const activity = Number(box?.lastDeliveredMessageId?.deliveredTime ?? 0)
    const known = lastIndexed.get(id) ?? 0
    if (activity > known) {
      targets.push({ id, activity })
    }
  }
  return targets.map((target) => target.id)
}

/**
 * Resolve the chat MID a parsed LINE message belongs to. Group/room messages
 * are keyed by their `to`; 1:1 (toType 0) messages are keyed by the peer (the
 * party that is not the authenticated user).
 *
 * @param message - Parsed LINE message from the poll loop.
 * @param myMid - Authenticated user's MID, or null.
 * @returns Chat MID, or null when it cannot be resolved.
 */
function resolveChatId(message: any, myMid: string | null): string | null {
  if (!message) {
    return null
  }
  if (message.toType === 0) {
    return message.from === myMid ? message.to : message.from
  }
  return message.to ?? null
}

/**
 * Start continuous capture for a resumed LINE session: run a one-time startup
 * catch-up, then keep the local index current from the live poll loop. Silent
 * and denylist-gated. Fire-and-forget: safe to call without awaiting.
 *
 * @param service - Resumed LineProtocolService (must have a live client).
 * @param embedder - Embedder used to keep semantic vectors current.
 * @returns Promise resolving once startup catch-up completes and polling starts.
 */
export async function startCapture(
  service: LineProtocolService,
  embedder?: Embedder,
): Promise<void> {
  // One writer for the shared index. A second Yomi process (a standalone
  // runtime next to the daemon, or a client-spawned server) stands down
  // instead of repeating the same catch-up and racing the same SQLite file.
  const lock = acquireCaptureLock()
  if (!lock) {
    log.info('capture.skipped_other_writer', {})
    return
  }

  try {
    const chatIds = await selectChatsNeedingCatchup(service)
    const summary = await collectMessages(service, {
      chatIds: chatIds.length > 0 ? chatIds : undefined,
      perChat: CATCHUP_PER_CHAT,
      embedder,
      budgetMs: CATCHUP_BUDGET_MS,
    })
    log.info('capture.catchup', {
      chatsTargeted: chatIds.length,
      chatsScanned: summary.chatsScanned,
      messagesIndexed: summary.messagesIndexed,
      messagesEmbedded: summary.messagesEmbedded,
    })
    // The graph starts out empty after a fresh install, so the first full
    // derivation runs right after the startup catch-up.
    const selfMid = service.profile?.mid ?? null
    if (selfMid) {
      const evidence = deriveAllEvidence(selfMid)
      log.info('capture.persona_initial', { evidence })
    }
  } catch (error: any) {
    // A runtime with no SQLite is not a hiccup this loop recovers from — the
    // index will stay empty for the life of the process and every later flush
    // fails the same way. Log it once, at error, and stop: a WARN here let a
    // Node 20 install poll silently for hours while capturing nothing.
    if (error instanceof SqliteUnavailableError) {
      log.error('capture.unavailable', {
        action: 'capture_disabled_for_this_process',
        error: error.message,
      })
      return
    }
    log.warn('capture.catchup_failed', {
      error: error?.message ?? String(error),
    })
  }

  const pending = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  // The embedding backlog is drained by a background worker in idle batches,
  // never inside a foreground request (see ./embedding-worker.ts).
  const embeddingWorker = embedder ? startEmbeddingWorker(embedder) : null
  if (embeddingWorker) {
    process.once('exit', () => embeddingWorker.stop())
  }

  const flush = async (): Promise<void> => {
    flushTimer = null
    const chatIds = [...pending]
    pending.clear()
    if (chatIds.length === 0) {
      return
    }
    try {
      await collectMessages(service, {
        chatIds,
        perChat: LIVE_PER_CHAT,
        embedder,
        skipBackfill: true,
      })
    } catch (error: any) {
      log.warn('capture.index_failed', {
        chats: chatIds.length,
        error: error?.message ?? String(error),
      })
    }
    persistCursor(service)
    refreshPersona(service.profile?.mid ?? null, chatIds)
    // New messages are now in the index but probably not embedded yet; let
    // the worker pick them up on its next tick.
    embeddingWorker?.nudge()
  }

  service.client.on('message', (message: any) => {
    const chatId = resolveChatId(message, service.profile?.mid ?? null)
    if (chatId) {
      pending.add(chatId)
    }
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        void flush()
      }, FLUSH_DEBOUNCE_MS)
    }
  })

  service.client.startPolling().catch((error: any) => {
    log.error('capture.polling_stopped', {
      error: error?.message ?? String(error),
    })
  })

  // The periodic full pass. The incremental pass above only sees the chats
  // that just changed; this one reads everything, so a role that changed
  // because of something elsewhere — a new title you started using in a
  // different chat — is still noticed.
  const fullTimer = setInterval(() => {
    const selfMid = service.profile?.mid ?? null
    if (!selfMid) {
      return
    }
    try {
      const evidence = deriveAllEvidence(selfMid)
      log.info('capture.persona_full', { evidence })
    } catch (error: any) {
      log.warn('capture.persona_full_failed', {
        error: error?.message ?? String(error),
      })
    }
  }, FULL_REDERIVE_INTERVAL_MS)
  fullTimer.unref?.()

  log.info('capture.started', {})
}

/**
 * Re-derive the roles of the people in the chats that just changed.
 *
 * Best-effort: the persona graph is a reading aid, and a failure to refresh
 * it must never take the capture loop down with it.
 *
 * @param selfMid - The account owner's LINE MID.
 * @param chatIds - The chats whose messages were just indexed.
 */
function refreshPersona(selfMid: string | null, chatIds: string[]): void {
  if (!selfMid || chatIds.length === 0) {
    return
  }
  try {
    const evidence = deriveEvidenceForChats(selfMid, chatIds)
    log.info('capture.persona_incremental', { chats: chatIds.length, evidence })
  } catch (error: any) {
    log.warn('capture.persona_incremental_failed', {
      error: error?.message ?? String(error),
    })
  }
}

/**
 * Persist the current LINE sync cursor for observability and future resume.
 *
 * @param service - Resumed LineProtocolService.
 */
function persistCursor(service: LineProtocolService): void {
  try {
    saveCaptureState({
      revision: Number(service.client.revision ?? 0),
      globalRevision: Number(service.client.globalRevision ?? 0),
      individualRevision: Number(service.client.individualRevision ?? 0),
      updatedAt: Date.now(),
    })
  } catch {
    // Cursor persistence is best-effort observability; never let it break capture.
  }
}
