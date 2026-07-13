/**
 * Yomi cross-conversation message collector.
 *
 * LINE only exposes per-conversation reads; there is no "search all my
 * chats" primitive server-side. This module is the explicit, caller-
 * invoked bulk fetch that pulls recent messages from one or more LINE
 * conversations and upserts them into the local FTS5 search index (see
 * ./store.ts) so search_messages has something to query.
 *
 * This is the ONLY place in Yomi allowed to bulk-fetch across chats, and
 * only because it is explicit: it runs exactly once per collect_messages
 * tool call, never on a timer, never in the background. The pure-query MCP
 * tools (list_conversations, get_chat_messages, ...) never call this and
 * remain unaffected.
 *
 * Reuses the existing read+decrypt path (LineProtocolService.
 * getRecentMessages, which already runs messages through E2EE decrypt) —
 * message fetching and decryption are not reimplemented here.
 *
 * Also batch-embeds each chat's collected messages (when an Embedder is
 * supplied) so semantic search has vectors to rank over. The embedder is
 * always caller-injected — never imported directly here — so the MCP
 * server can pass its DefaultEmbedder while a host app (e.g. inboxd) can
 * pass its own local model instead. Embedding failure (model unavailable,
 * offline first run, etc.) is caught per-chat and never aborts collection:
 * messages + bigram search_text are always stored regardless of whether
 * embedding succeeded, so keyword search keeps working either way.
 */

import type { LineProtocolService } from '../line/core/service.js'
import { resolveConversationNames, resolveSenderNames } from '../mcp/names.js'
import { createCliLogger } from '../util/log.js'
import type { Embedder } from './embedder.js'
import { getExcludedChatIds } from './scope.js'
import {
  getMessagesMissingEmbedding,
  type MessageRecord,
  upsertEmbeddings,
  upsertMessages,
} from './store.js'

const log = createCliLogger('Yomi')

const EMBED_BATCH = 64

/** Options for one collect_messages run. */
export interface CollectMessagesOptions {
  /** Chat MIDs to collect from. Omit to collect from all conversations. */
  chatIds?: string[]
  /** Maximum recent messages to fetch per chat (default 100). */
  perChat?: number
  /**
   * Embedder to batch-embed collected messages with, for semantic search.
   * Omit to skip embedding entirely (index stays keyword-only).
   */
  embedder?: Embedder
}

/** Summary of one collect_messages run. */
export interface CollectMessagesSummary {
  chatsScanned: number
  messagesIndexed: number
  /** Messages successfully embedded for semantic search (0 when no embedder was supplied or embedding failed). */
  messagesEmbedded: number
}

const DEFAULT_PER_CHAT = 100
const DEFAULT_CHAT_LIMIT = 200

/**
 * Resolve the target chat ids for a collection run, along with a
 * best-effort display name for each.
 *
 * @param service - Resumed LineProtocolService.
 * @param chatIds - Caller-supplied chat ids; when omitted, all conversations are used.
 * @returns Map of chat MID to resolved name (null when unresolvable).
 */
async function resolveTargetChats(
  service: LineProtocolService,
  chatIds: string[] | undefined,
): Promise<Map<string, string | null>> {
  if (chatIds && chatIds.length > 0) {
    return resolveConversationNames(service, chatIds)
  }
  const result = await service.client.getMessageBoxes({
    lastMessagesPerMessageBoxCount: 1,
    messageBoxCountLimit: DEFAULT_CHAT_LIMIT,
    withUnreadCount: false,
  })
  const boxes = result.messageBoxes || []
  const ids = boxes.map((box: any) => box.id).filter(Boolean)
  return resolveConversationNames(service, ids)
}

/**
 * Collect recent messages from one or more LINE conversations and upsert
 * them into the local search index. Explicit operation — runs only when a
 * caller invokes the `collect_messages` MCP tool.
 *
 * Messages without decrypted/plaintext text (media-only, or E2EE-locked)
 * are skipped rather than indexed as empty rows — nothing fabricated.
 * Chats on the exclusion denylist (see ../search/scope.ts) are dropped
 * before the fetch loop, so they are never fetched from LINE or indexed.
 *
 * @param service - Resumed LineProtocolService.
 * @param options - Collection options.
 * @returns Summary of chats scanned and messages indexed.
 */
export async function collectMessages(
  service: LineProtocolService,
  options: CollectMessagesOptions = {},
): Promise<CollectMessagesSummary> {
  const perChat = options.perChat ?? DEFAULT_PER_CHAT
  const chatNames = await resolveTargetChats(service, options.chatIds)
  // Scoping is a denylist: excluded chats are removed here, before the
  // fetch loop below, so they are never fetched from LINE or indexed —
  // not just filtered out of the results afterward. See ../search/scope.ts.
  const excluded = getExcludedChatIds()
  for (const chatId of excluded) {
    chatNames.delete(chatId)
  }
  let messagesIndexed = 0
  let messagesEmbedded = 0

  for (const [chatId, chatName] of chatNames) {
    const messages = await service.getRecentMessages(chatId, perChat)
    const withText = messages.filter(
      (message: any) =>
        typeof message.text === 'string' && message.text.length > 0,
    )
    if (withText.length === 0) {
      continue
    }
    const senderNames = await resolveSenderNames(
      service,
      withText.map((message: any) => message.from).filter(Boolean),
    )
    const rows: MessageRecord[] = withText.map((message: any) => ({
      chatId,
      chatName: chatName ?? null,
      messageId: String(message.id),
      fromMid: message.from ?? null,
      fromName: senderNames.get(message.from) ?? null,
      text: message.text,
      createdTime: message.createdTime ?? message.deliveredTime ?? null,
    }))
    messagesIndexed += upsertMessages(rows)
    messagesEmbedded += await embedAndStore(rows, options.embedder)
  }

  // Self-heal embedding coverage: embed anything already in the index that
  // still lacks a vector for this model — legacy keyword-only rows, or rows
  // from a run where the model wasn't loaded. This is why re-running
  // collect_messages repairs a partially-embedded index without re-fetching
  // from LINE. The rows just embedded above are no longer "missing", so they
  // are not embedded twice.
  if (options.embedder) {
    messagesEmbedded += await backfillMissingEmbeddings(options.embedder)
  }

  return { chatsScanned: chatNames.size, messagesIndexed, messagesEmbedded }
}

/**
 * Embed every indexed message that still lacks a vector for the given
 * model, in batches, from stored text alone (no LINE round-trip). Best-
 * effort like embedAndStore: if the model fails mid-sweep it stops and
 * returns what it managed, leaving the rest keyword-only rather than
 * aborting. Idempotent — a fully-embedded index makes this a no-op.
 *
 * @param embedder - Injected embedder to embed missing rows with.
 * @returns Number of messages newly embedded and stored.
 */
export async function backfillMissingEmbeddings(
  embedder: Embedder,
): Promise<number> {
  const missing = getMessagesMissingEmbedding(embedder.modelLabel)
  if (missing.length === 0) {
    return 0
  }
  let embedded = 0
  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH)
    try {
      const vectors = await embedder.embed(batch.map((row) => row.text))
      embedded += upsertEmbeddings(
        batch.map((row, j) => ({
          messageId: row.messageId,
          vector: vectors[j],
        })),
        embedder.modelLabel,
      )
    } catch (error: any) {
      log.warn('backfill.failed', {
        error: error?.message ?? String(error),
        remaining: missing.length - embedded,
      })
      break
    }
  }
  return embedded
}

/**
 * Batch-embed a chat's collected messages and store the resulting vectors,
 * when an Embedder was supplied. Embedding is best-effort: any failure
 * (model unavailable, offline, OOM, etc.) is caught and logged, never
 * thrown — messages are already durably stored via upsertMessages by the
 * time this runs, so a failed embed only means that batch stays
 * keyword-only, not that collection itself failed.
 *
 * @param rows - Messages already upserted this batch.
 * @param embedder - Injected embedder, or undefined to skip embedding.
 * @returns Number of messages successfully embedded and stored.
 */
async function embedAndStore(
  rows: MessageRecord[],
  embedder: Embedder | undefined,
): Promise<number> {
  if (!embedder || rows.length === 0) {
    return 0
  }
  try {
    const vectors = await embedder.embed(rows.map((row) => row.text))
    return upsertEmbeddings(
      rows.map((row, i) => ({ messageId: row.messageId, vector: vectors[i] })),
      embedder.modelLabel,
    )
  } catch (error: any) {
    log.warn('embed.failed', {
      error: error?.message ?? String(error),
      count: rows.length,
    })
    return 0
  }
}
