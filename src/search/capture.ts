/**
 * Yomi continuous capture — the in-process, silent, denylist-gated sync loop.
 *
 * Unlike collect_messages (explicit, one-shot, caller-invoked), this runs for
 * the life of the MCP process: LINE's stdio MCP server is spawned once by the
 * client and lives as long as that client, so a background loop here keeps the
 * local search index current while the user is actually using the app.
 *
 * Two mechanisms:
 *   - Startup catch-up: one collectMessages() over all conversations, to fill
 *     the gap for anything that arrived while the process was down. Idempotent
 *     (upsert), and denylist-gated inside collectMessages.
 *   - Live loop: LINE's startPolling long-polls SYNC4; on each new message we
 *     index just the affected chat via collectMessages({ chatIds }).
 *
 * This is SILENT: SYNC4 sync never sends a read receipt, so capture never marks
 * anything read. Excluded (denylisted) chats are dropped inside collectMessages,
 * so they are never fetched or indexed. Sending/read-receipts are never
 * triggered here.
 */

import type { LineProtocolService } from '../line/core/service.js'
import { createCliLogger } from '../util/log.js'
import { collectMessages } from './collector.js'
import type { Embedder } from './embedder.js'
import { SqliteUnavailableError } from './sqlite.js'
import { saveCaptureState } from './store.js'

const log = createCliLogger('Yomi')

/** Milliseconds to batch new-message signals before indexing affected chats. */
const FLUSH_DEBOUNCE_MS = 2000
/** Recent messages to (re)index per affected chat on a live flush. */
const LIVE_PER_CHAT = 30

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
  embedder: Embedder,
): Promise<void> {
  try {
    const summary = await collectMessages(service, { embedder })
    log.info('capture.catchup', {
      chatsScanned: summary.chatsScanned,
      messagesIndexed: summary.messagesIndexed,
    })
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
      })
    } catch (error: any) {
      log.warn('capture.index_failed', {
        chats: chatIds.length,
        error: error?.message ?? String(error),
      })
    }
    persistCursor(service)
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

  log.info('capture.started', {})
  service.client.startPolling().catch((error: any) => {
    log.error('capture.polling_stopped', {
      error: error?.message ?? String(error),
    })
  })
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
