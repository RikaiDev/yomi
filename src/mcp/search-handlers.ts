/**
 * Yomi cross-conversation search tool handlers — collect_messages and
 * search_messages.
 *
 * Split out from handlers.ts because these two tools are the boundary
 * between the pure-query LINE tools (handlers.ts) and the local search
 * index in ../search/ (see store.ts, collector.ts): collect_messages
 * writes to that index, search_messages reads from it. No other tool
 * touches the index.
 *
 * search_messages is HYBRID: it always runs FTS5 keyword search (bigram-
 * preprocessed, so it covers every indexed message and guarantees exact
 * substring matches are never lost) and, when embeddings exist for the
 * current model, also runs semantic search (cosine similarity over
 * transformers.js embeddings, see ../search/default-embedder.ts). The two
 * ranked lists are fused by Reciprocal Rank Fusion (see fuseByRrf) so a
 * result that either method ranks highly surfaces near the top. This is
 * deliberately not "semantic OR keyword": pure semantic over a partially-
 * embedded index silently drops exact matches that live in un-embedded
 * messages (the "search 台東 misses the chat that literally says 台東" bug),
 * and pure keyword misses paraphrases. Which methods actually contributed
 * is always reported via the `mode` field (`hybrid` | `semantic` |
 * `keyword`), never hidden.
 */

import type { LineProtocolService } from '../line/core/service.js'
import { collectMessages } from '../search/collector.js'
import { getDefaultEmbedder } from '../search/default-embedder.js'
import {
  getEmbeddingCount,
  getIndexedMessageCount,
  type SearchResult,
  type SemanticSearchResult,
  searchMessages,
  semanticSearch,
} from '../search/store.js'
import { createCliLogger } from '../util/log.js'
import { toolError } from './handlers.js'
import { createPhiAccumulator, maskInto, phiNote } from './phi-guard.js'

const log = createCliLogger('Yomi')

/**
 * Reciprocal Rank Fusion constant. The standard k=60 from Cormack et al.:
 * a result's contribution from one list is 1/(k + rank), so rank matters
 * but no single list can dominate on raw score scale (bm25's negative log
 * scores and cosine's [0,1] are never compared directly — only their
 * ranks are). Larger k flattens the rank curve; 60 is the well-tested default.
 */
const RRF_K = 60

/**
 * Merge several already-ranked result lists into one, deduping by
 * messageId, using Reciprocal Rank Fusion. Each list contributes
 * 1/(RRF_K + rank) to a message's fused score; scores sum across lists, so
 * a message ranked highly by BOTH keyword and semantic search rises above
 * one ranked highly by only one. The returned `score` is the fused RRF
 * score (NOT a cosine similarity or bm25 value) — it exists only to order
 * results, and is reported as-is rather than dressed up as a probability.
 *
 * @param lists - Ranked result lists (best-first) to fuse.
 * @param limit - Maximum number of fused results to return.
 * @returns Fused results, best-first, each carrying its RRF score.
 */
function fuseByRrf(
  lists: SearchResult[][],
  limit: number,
): (SearchResult & { score: number })[] {
  const scores = new Map<string, number>()
  const rows = new Map<string, SearchResult>()
  for (const list of lists) {
    list.forEach((row, rank) => {
      scores.set(
        row.messageId,
        (scores.get(row.messageId) ?? 0) + 1 / (RRF_K + rank),
      )
      if (!rows.has(row.messageId)) {
        rows.set(row.messageId, row)
      }
    })
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([messageId, score]) => ({
      ...(rows.get(messageId) as SearchResult),
      score,
    }))
}

/**
 * Handle `collect_messages` — explicit bulk fetch of recent messages from
 * one or more LINE conversations into the local search index, batch-
 * embedding each chat's messages with the default embedder along the way
 * (best-effort — see ../search/collector.ts's embedAndStore for the
 * failure-never-blocks-collection guarantee). The only tool allowed to
 * bulk-fetch across chats; runs exactly once per call.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result summarizing what was indexed and embedded.
 */
export async function handleCollectMessages(
  service: LineProtocolService,
  args: { chatIds?: string[]; perChat?: number },
) {
  const summary = await collectMessages(service, {
    chatIds: args.chatIds,
    perChat: args.perChat,
    embedder: getDefaultEmbedder(),
  })
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(summary, null, 2) },
    ],
  }
}

/**
 * Handle `search_messages` — hybrid keyword + semantic search, fused by
 * Reciprocal Rank Fusion (see fuseByRrf). Keyword search always runs and
 * covers every indexed message, so exact matches are never dropped;
 * semantic search additionally runs whenever vectors exist for the current
 * model, adding paraphrase recall. `mode` reports which methods contributed.
 *
 * Auto-collects on an empty index: the first search with a live session
 * transparently runs a full `collect_messages` across all conversations
 * before searching, so callers never have to know `collect_messages`
 * exists — searching "just works" out of the box. This is the one place
 * search itself may hit LINE; a non-empty index searches locally with no
 * network. Ongoing freshness is not this handler's job: the background
 * capture loop (see ../search/capture.ts) indexes incoming messages as they
 * arrive, so the index stays current without search re-collecting on every
 * query (which would cost tens of seconds of latency — not any rate limit,
 * which we have never observed). With an empty index and no session, it says
 * so honestly rather than returning a silently empty result.
 *
 * @param service - Resumed LineProtocolService (used only to auto-collect an empty index).
 * @param args - Tool arguments.
 * @returns MCP tool result with `{ mode, results }`, or an honest notice.
 */
export async function handleSearchMessages(
  service: LineProtocolService,
  args: { query: string; limit?: number },
) {
  if (!args.query) {
    return toolError('query is required.')
  }
  if (getIndexedMessageCount() === 0) {
    if (!service.client) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Search index is empty and there is no LINE session — log in first; the index then builds automatically on your next search.',
          },
        ],
      }
    }
    log.info('search.auto_collect', { reason: 'empty_index' })
    const summary = await collectMessages(service, {
      embedder: getDefaultEmbedder(),
    })
    log.info('search.auto_collect_done', { ...summary })
    if (getIndexedMessageCount() === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Nothing to search — auto-collect found no readable messages across your conversations.',
          },
        ],
      }
    }
  }
  const limit = args.limit ?? 20
  // Pull a deeper candidate pool from each method than the caller's limit,
  // so RRF has enough overlap/depth to reorder meaningfully before slicing.
  const pool = Math.max(limit * 3, 30)
  const embedder = getDefaultEmbedder()

  const keyword = searchMessages(args.query, pool)
  let semantic: SemanticSearchResult[] = []
  if (getEmbeddingCount(embedder.modelLabel) > 0) {
    try {
      semantic = await semanticSearch(args.query, pool, embedder)
    } catch (error: any) {
      log.warn('search.semantic_failed', {
        error: error?.message ?? String(error),
      })
    }
  }

  let mode: 'hybrid' | 'semantic' | 'keyword'
  let results: unknown[]
  if (semantic.length > 0 && keyword.length > 0) {
    mode = 'hybrid'
    results = fuseByRrf([keyword, semantic], limit)
  } else if (semantic.length > 0) {
    mode = 'semantic'
    results = semantic.slice(0, limit)
  } else {
    mode = 'keyword'
    results = keyword.slice(0, limit)
  }

  const acc = createPhiAccumulator()
  const maskedResults = (results as { text?: string }[]).map((row) => ({
    ...row,
    text: maskInto(acc, row.text),
  }))
  const content: any[] = [
    {
      type: 'text' as const,
      text: JSON.stringify({ mode, results: maskedResults }, null, 2),
    },
  ]
  const note = phiNote(acc)
  if (note) content.push(note)
  return { content }
}
