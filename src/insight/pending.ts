/**
 * Open threads — conversations whose latest message is not yours — as compact
 * directed edges for a network the agent reads cheaply, not raw thread dumps.
 *
 * The tool's job stops at structure and statistics: which conversation, whether
 * it is 1:1, who spoke last, how long it has waited, and how that compares to
 * the relationship's own reply rhythm. It does NOT parse who a message is
 * addressed to, resolve nicknames, or judge open-request vs closing-ack — those
 * are language understanding (addressing conventions, illocutionary force,
 * identity) that hand-written heuristics only overfit to one corpus. The agent
 * reads the `preview` (and fetches the thread when needed) and does all of that
 * itself, in any language, with no brittle rules here. `typicality` (embedding
 * density) is a boilerplate-shape hint only — it also buries polite requests,
 * so it must not be used as a filter.
 */

import type { MessageVectorRow } from '../search/store.js'
import { replyRhythmHours } from './rhythm.js'

/** An open thread as a directed edge, with a pointer to fetch detail on demand. */
export interface OpenThread {
  chatId: string
  chatName: string | null
  /** 1:1 conversation (at most you plus one other speaker seen). */
  isDM: boolean
  /** Last speaker (the edge source). */
  fromName: string | null
  waitHours: number
  rhythmHours: number | null
  /** waitHours relative to the relationship's rhythm; higher = more overdue. */
  overdueRatio: number
  /** Embedding density in [~0,1]; high = boilerplate-shaped. A hint, not a verdict. */
  typicality: number
  /** Preview of the latest message — the agent reads this to judge addressee and intent. */
  preview: string
  /** Pointer for the agent to fetch the full thread only if it decides to judge. */
  lastMessageId: string
  lastTimeMs: number
}

export interface PendingOptions {
  /** Neighbours used for the density/typicality estimate (default 15). */
  densityK?: number
  /** Preview length in characters (default 80). */
  previewChars?: number
}

const HOUR = 3_600_000

function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i++) {
    s += a[i] * b[i]
  }
  return s
}

/** Mean of the top-K cosine similarities to all other messages (typicality). */
function typicality(vec: Float32Array, all: Float32Array[], k: number): number {
  const scores: number[] = []
  for (const v of all) {
    if (v !== vec) {
      scores.push(dot(vec, v))
    }
  }
  scores.sort((a, b) => b - a)
  const top = scores.slice(0, k)
  return top.length ? top.reduce((s, x) => s + x, 0) / top.length : 0
}

/**
 * Find open threads across all conversations you participate in.
 *
 * @param rows - All windowed messages with vectors.
 * @param selfMid - The account owner's MID.
 * @param nowMs - Reference "now" (typically the newest captured message time).
 * @param opts - Density-K and preview length.
 * @returns Open threads, most overdue first.
 */
export function findPending(
  rows: MessageVectorRow[],
  selfMid: string | null,
  nowMs: number,
  opts: PendingOptions = {},
): OpenThread[] {
  const k = opts.densityK ?? 15
  const previewChars = opts.previewChars ?? 80
  const allVecs = rows.map((r) => r.vector)

  const byChat = new Map<string, MessageVectorRow[]>()
  for (const r of rows) {
    const list = byChat.get(r.chatId)
    if (list) {
      list.push(r)
    } else {
      byChat.set(r.chatId, [r])
    }
  }

  const items: OpenThread[] = []
  for (const [, msgs] of byChat) {
    const senders = new Set(msgs.map((m) => m.fromMid).filter(Boolean))
    if (selfMid == null || !senders.has(selfMid)) {
      continue
    }
    const sorted = [...msgs].sort((a, b) => a.createdTime - b.createdTime)
    const last = sorted[sorted.length - 1]
    if (last.fromMid === selfMid) {
      continue // ball is in their court
    }

    const rhythmHours = replyRhythmHours(sorted, selfMid)
    const waitHours = (nowMs - last.createdTime) / HOUR
    items.push({
      chatId: last.chatId,
      chatName: last.chatName,
      isDM: senders.size <= 2,
      fromName: last.fromName,
      waitHours,
      rhythmHours,
      overdueRatio: rhythmHours
        ? waitHours / Math.max(rhythmHours, 0.25)
        : waitHours / 24,
      typicality: typicality(last.vector, allVecs, k),
      preview: last.text.replace(/\s+/g, ' ').slice(0, previewChars),
      lastMessageId: last.messageId,
      lastTimeMs: last.createdTime,
    })
  }

  items.sort((a, b) => b.overdueRatio - a.overdueRatio)
  return items
}
