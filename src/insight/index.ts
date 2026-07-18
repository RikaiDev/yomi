/**
 * The insight layer's first stage: build structured, unsupervised context for
 * an agent to reason over — it does not decide what needs attention itself.
 *
 * The division of labour is deliberate. Determining whether a message is an
 * open request or a closing acknowledgement is illocutionary force, which topic
 * embeddings provably do not encode (see ./pending), so no amount of clustering
 * or scoring here can decide "needs attention" without guessing. Instead this
 * stage assembles what CAN be computed without content understanding — the
 * relationship graph (./relationships), reply rhythm (./rhythm), and the
 * candidate pending items with their thread context (./pending) — and returns
 * it as a package. The agent consuming the tool makes the final call, grounded
 * in that context rather than in a raw message dump.
 */

import type { Embedder } from '../search/embedder.js'
import { getEmbeddingCount, getMessagesWithVectors } from '../search/store.js'
import { findPending, type OpenThread } from './pending.js'
import {
  buildRelationships,
  type Connector,
  findConnectors,
  type Relationship,
} from './relationships.js'

/**
 * A compact context network for the agent to reason over cheaply. Nodes are
 * people (`connectors` — the cross-conversation hubs) and conversations
 * (`relationships`); `open` are directed edges (last speaker → addressee) for
 * threads awaiting a reply. It intentionally carries no message threads — each
 * open edge is a pointer the agent dereferences (get_chat_messages) only for
 * the few it decides to judge.
 */
export interface InsightPackage {
  window: { fromMs: number; toMs: number; messages: number }
  /** Conversation nodes: per-conversation engagement (the 對象/關係 axis). */
  relationships: Relationship[]
  /** Person nodes spanning ≥2 conversations — the network's cross-channel hubs. */
  connectors: Connector[]
  /** Open directed edges: threads awaiting a reply, most overdue first. */
  open: OpenThread[]
}

export interface ComputeInsightsOptions {
  /** Restrict relationships and pending items to this chat. */
  focusChatId?: string
  /** Lookback window in hours (default 21 days). */
  sinceHours?: number
  /** The account owner's MID, for who-owes-whom. */
  selfMid: string | null
  /** Embedder whose model label selects which stored vectors to read. */
  embedder: Embedder
}

const DEFAULT_LOOKBACK_MS = 21 * 24 * 60 * 60 * 1000

const EMPTY: InsightPackage = {
  window: { fromMs: 0, toMs: 0, messages: 0 },
  relationships: [],
  connectors: [],
  open: [],
}

/**
 * Assemble the insight context package over the local index.
 *
 * @param opts - Focus, window, self identity, and embedder model selection.
 * @returns The relationship graph, connectors, and pending candidates.
 */
export function computeInsights(opts: ComputeInsightsOptions): InsightPackage {
  const model = opts.embedder.modelLabel
  if (getEmbeddingCount(model) === 0) {
    return EMPTY
  }
  const all = getMessagesWithVectors(model)
  if (all.length === 0) {
    return EMPTY
  }

  // Window anchors to the newest captured message, not wall-clock: capture can
  // lag, and the analysis should look back from the data's own edge.
  const newest = all[all.length - 1].createdTime
  const lookback = opts.sinceHours
    ? opts.sinceHours * 60 * 60 * 1000
    : DEFAULT_LOOKBACK_MS
  const since = newest - lookback
  const rows = all.filter((r) => r.createdTime >= since)

  let relationships = buildRelationships(rows, opts.selfMid)
  const connectors = findConnectors(rows, opts.selfMid)
  let open = findPending(rows, opts.selfMid, newest)

  if (opts.focusChatId) {
    relationships = relationships.filter((r) => r.chatId === opts.focusChatId)
    open = open.filter((o) => o.chatId === opts.focusChatId)
  }

  return {
    window: { fromMs: since, toMs: newest, messages: rows.length },
    relationships,
    connectors,
    open,
  }
}
