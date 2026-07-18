/**
 * The relationship layer: who you talk to, how, and how often — the 對象/關係
 * axis of the analysis, built purely from interaction structure (no message
 * content). This is unsupervised context for the agent's final judgement, not a
 * judgement itself.
 *
 * Two views:
 *   - per-conversation engagement (reciprocity, rhythm, recency), so a pending
 *     item can be weighed by how much the relationship actually matters;
 *   - cross-conversation connectors: people who appear in more than one of your
 *     chats, with the structural bridges among them found as articulation
 *     points of the person co-occurrence graph (see ./graph).
 */

import type { MessageVectorRow } from '../search/store.js'
import { articulationPoints, type Edge } from './graph.js'
import { replyRhythmHours } from './rhythm.js'

/** One conversation and your engagement with it. */
export interface Relationship {
  chatId: string
  chatName: string | null
  /** A 1:1 conversation (at most you plus one other speaker seen). */
  isDM: boolean
  participantCount: number
  totalMessages: number
  yourMessages: number
  /** Share of messages that are yours — engagement balance in [0,1]. */
  reciprocity: number
  /** Your typical reply latency in this chat, in hours (see ./rhythm). */
  rhythmHours: number | null
  lastActivityMs: number
}

/** A person who appears across more than one of your conversations. */
export interface Connector {
  mid: string
  name: string | null
  chatCount: number
  /** Whether removing this person disconnects part of your contact network. */
  isBridge: boolean
}

/**
 * Build per-conversation engagement stats for every chat you have spoken in.
 *
 * @param rows - All windowed messages.
 * @param selfMid - The account owner's MID.
 * @returns One Relationship per chat you participate in, most recent first.
 */
export function buildRelationships(
  rows: MessageVectorRow[],
  selfMid: string | null,
): Relationship[] {
  const byChat = new Map<string, MessageVectorRow[]>()
  for (const r of rows) {
    const list = byChat.get(r.chatId)
    if (list) {
      list.push(r)
    } else {
      byChat.set(r.chatId, [r])
    }
  }

  const out: Relationship[] = []
  for (const [chatId, msgs] of byChat) {
    const senders = new Set(msgs.map((m) => m.fromMid).filter(Boolean))
    if (selfMid == null || !senders.has(selfMid)) {
      continue
    }
    const yourMessages = msgs.filter((m) => m.fromMid === selfMid).length
    out.push({
      chatId,
      chatName: msgs[msgs.length - 1].chatName,
      isDM: senders.size <= 2,
      participantCount: senders.size,
      totalMessages: msgs.length,
      yourMessages,
      reciprocity: yourMessages / msgs.length,
      rhythmHours: replyRhythmHours(msgs, selfMid),
      lastActivityMs: Math.max(...msgs.map((m) => m.createdTime)),
    })
  }
  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs)
  return out
}

/**
 * Find people who appear across two or more of your conversations, and mark
 * those that are structural bridges (articulation points) of the person
 * co-occurrence graph — nodes whose removal would disconnect your network.
 *
 * @param rows - All windowed messages.
 * @param selfMid - The account owner's MID (excluded — you connect everything).
 * @returns Cross-conversation connectors, most-chats first.
 */
export function findConnectors(
  rows: MessageVectorRow[],
  selfMid: string | null,
): Connector[] {
  // person → chats they speak in, and their display name.
  const chatsOf = new Map<string, Set<string>>()
  const nameOf = new Map<string, string | null>()
  // chat → the set of people in it, to build co-occurrence edges.
  const peopleIn = new Map<string, Set<string>>()
  const addTo = (map: Map<string, Set<string>>, key: string, value: string) => {
    const set = map.get(key)
    if (set) {
      set.add(value)
    } else {
      map.set(key, new Set([value]))
    }
  }
  for (const r of rows) {
    const mid = r.fromMid
    if (!mid || mid === selfMid) {
      continue
    }
    addTo(chatsOf, mid, r.chatId)
    addTo(peopleIn, r.chatId, mid)
    if (!nameOf.has(mid)) {
      nameOf.set(mid, r.fromName)
    }
  }

  const people = [...chatsOf.keys()]
  const index = new Map(people.map((mid, i) => [mid, i]))
  const seenEdge = new Set<string>()
  const edges: Edge[] = []
  for (const members of peopleIn.values()) {
    const list = [...members]
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = index.get(list[i]) as number
        const b = index.get(list[j]) as number
        const key = a < b ? `${a}-${b}` : `${b}-${a}`
        if (!seenEdge.has(key)) {
          seenEdge.add(key)
          edges.push({ a, b })
        }
      }
    }
  }
  const bridges = articulationPoints(people.length, edges)

  const out: Connector[] = []
  for (const mid of people) {
    const chatCount = chatsOf.get(mid)?.size ?? 0
    if (chatCount < 2) {
      continue
    }
    out.push({
      mid,
      name: nameOf.get(mid) ?? null,
      chatCount,
      isBridge: bridges.has(index.get(mid) as number),
    })
  }
  out.sort((a, b) => b.chatCount - a.chatCount)
  return out
}
