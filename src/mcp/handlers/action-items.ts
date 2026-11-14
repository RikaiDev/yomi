/**
 * "Ball in court" analysis — AI-native, heuristic action-item detection over
 * LINE conversations (who likely needs to act next).
 *
 * Uses local embedding semantic similarity (natural-language intent anchors)
 * plus conversation structure (sender, recency, unread state, mentions, group)
 * instead of hardcoded keyword dictionaries. Returns reasons, confidence, and
 * evidence for inspection. Read-only: no marks-read, no index writes.
 */

import { CONTENT_TYPE } from '../../line/core/constants.js'
import { listBoxesByRecency } from '../../line/core/message-box-recency.js'
import { sanitizeMessagePreview } from '../../line/core/message-preview.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { getDefaultEmbedder } from '../../search/default-embedder.js'
import type { Embedder } from '../../search/embedder.js'
import { getExcludedChatIds } from '../../search/scope.js'
import { resolveConversationNames, resolveSenderNames } from '../names.js'
import { createPhiAccumulator, maskInto, phiNote } from '../phi-guard.js'
import { toonText } from './shared.js'

type Ball = 'mine' | 'theirs' | 'team' | 'none' | 'unknown'
type Confidence = 'high' | 'medium' | 'low'

interface BallResult {
  ball: Ball
  confidence: Confidence
  reasons: string[]
  evidence?: any
}

type Intent =
  | 'actionable_request'
  | 'informational_or_ack'
  | 'broadcast_or_promo'
  | 'directed_to_other'

const INTENT_ANCHORS: Record<Intent, string[]> = {
  actionable_request: [
    'asks me a question and expects my answer or decision',
    'requests me to do something, provide information, confirm, arrange, send, pay, reply, or take action',
    'follows up waiting for my response or a task I need to handle',
  ],
  informational_or_ack: [
    'shares information, status, or thanks with no action or reply needed from me',
    'a brief acknowledgement, greeting, or closing message that does not ask me to do anything',
  ],
  broadcast_or_promo: [
    'a broadcast announcement, promotion, advertisement, or notification sent to many people, not a personal request to me',
  ],
  directed_to_other: [
    'addressed to another specific person in the conversation, asking them (not me) to act or reply',
  ],
}

let anchorVectorsPromise: Promise<Map<Intent, number[][]>> | null = null

function dot(a: number[], b: number[]): number {
  let v = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) v += a[i] * b[i]
  return v
}

async function getAnchorVectors(
  embedder: Embedder,
): Promise<Map<Intent, number[][]>> {
  if (!anchorVectorsPromise) {
    anchorVectorsPromise = (async () => {
      const intents = Object.keys(INTENT_ANCHORS) as Intent[]
      const texts = intents.flatMap((i) => INTENT_ANCHORS[i])
      const vecs = await embedder.embed(texts)
      const map = new Map<Intent, number[][]>()
      let idx = 0
      for (const intent of intents) {
        map.set(intent, vecs.slice(idx, idx + INTENT_ANCHORS[intent].length))
        idx += INTENT_ANCHORS[intent].length
      }
      return map
    })().catch((err) => {
      anchorVectorsPromise = null
      throw err
    })
  }
  return anchorVectorsPromise
}

async function classifyIntent(
  texts: string[],
  embedder: Embedder,
): Promise<Array<{ intent: Intent; score: number; margin: number }>> {
  if (texts.length === 0) return []
  const anchors = await getAnchorVectors(embedder)
  const msgVecs = await embedder.embed(texts.map((t) => t || 'no text content'))
  const intents = Object.keys(INTENT_ANCHORS) as Intent[]
  return msgVecs.map((mv) => {
    const scores = new Map<Intent, number>()
    for (const intent of intents) {
      let best = -Infinity
      for (const av of anchors.get(intent) ?? []) {
        best = Math.max(best, dot(mv, av))
      }
      scores.set(intent, best)
    }
    const ranked = [...intents].sort(
      (a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0),
    )
    const top = ranked[0]
    const second = ranked[1]
    return {
      intent: top,
      score: scores.get(top) ?? 0,
      margin: (scores.get(top) ?? 0) - (scores.get(second) ?? 0),
    }
  })
}

function messageTimestamp(message: any): number {
  return Number(message?.deliveredTime || message?.createdTime || 0)
}

function isMe(message: any, myMid: string | null): boolean {
  return Boolean(myMid) && message?.from === myMid
}

function textOf(message: any): string {
  const t = String(message?.text ?? '').trim()
  if (!t || t === '[加密訊息]' || t === '[社群訊息]') return ''
  return t
}

function isMeaningful(message: any): boolean {
  const ct = Number(message?.contentType ?? 0)
  if (textOf(message).length > 0) return true
  const noise = new Set([
    CONTENT_TYPE.NONE,
    CONTENT_TYPE.PRESENCE,
    CONTENT_TYPE.GROUPBOARD,
    CONTENT_TYPE.POSTNOTIFICATION,
    CONTENT_TYPE.CHATEVENT,
  ])
  if (noise.has(ct)) return false
  return true
}

function contentTypeLabel(ct: number): string {
  const map: Record<number, string> = {
    [CONTENT_TYPE.IMAGE]: 'image',
    [CONTENT_TYPE.VIDEO]: 'video',
    [CONTENT_TYPE.AUDIO]: 'audio',
    [CONTENT_TYPE.FILE]: 'file',
    [CONTENT_TYPE.LOCATION]: 'location',
    [CONTENT_TYPE.CONTACT]: 'contact',
    [CONTENT_TYPE.STICKER]: 'sticker',
    [CONTENT_TYPE.RICH]: 'rich',
    [CONTENT_TYPE.FLEX]: 'flex',
  }
  return map[ct] ?? ''
}

function mentionsSomeone(
  message: any,
  myMid: string | null,
): { me: boolean; all: boolean } {
  const raw = message?.contentMetadata?.MENTION
  let all = false
  let me = false
  if (raw) {
    try {
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
      const list = parsed?.MENTIONEES ?? parsed?.MENTIONS ?? []
      for (const m of list) {
        if (m?.A === 1 || m?.all === 1) all = true
        const mid = String(m?.M ?? m?.mid ?? '')
        if (myMid && mid === myMid) me = true
      }
    } catch {}
  }
  return { me, all }
}

function messagePreview(message: any): string {
  const text = sanitizeMessagePreview(textOf(message))
  if (text) return text
  const label = contentTypeLabel(Number(message?.contentType ?? 0))
  return label ? `[${label}]` : ''
}

async function classifyBall(
  messages: any[],
  myMid: string | null,
  isGroup: boolean,
  unreadCount: number,
  embedder: Embedder | null,
): Promise<BallResult & { lastInbound?: any; lastMine?: any }> {
  const meaningful = messages
    .filter(isMeaningful)
    .sort((a, b) => messageTimestamp(a) - messageTimestamp(b))
  if (meaningful.length === 0) {
    return {
      ball: 'none',
      confidence: 'low',
      reasons: ['no_meaningful_message'],
    }
  }

  const last = meaningful[meaningful.length - 1]
  const lastMine = [...meaningful].reverse().find((m) => isMe(m, myMid))
  const lastInbound = [...meaningful].reverse().find((m) => !isMe(m, myMid))
  const inboundAfterMine = lastMine
    ? meaningful.filter(
        (m) =>
          !isMe(m, myMid) && messageTimestamp(m) > messageTimestamp(lastMine),
      )
    : meaningful.filter((m) => !isMe(m, myMid))

  const pendingInbound = unreadCount > 0 || inboundAfterMine.length > 0

  // Semantic classification over relevant texts (AI-native)
  let intentById = new Map<
    string,
    { intent: Intent; score: number; margin: number }
  >()
  const candidates = pendingInbound
    ? inboundAfterMine.length > 0
      ? inboundAfterMine
      : lastInbound
        ? [lastInbound]
        : []
    : last && isMe(last, myMid)
      ? [last]
      : []
  const textCandidates = candidates
    .map((m) => ({ m, t: textOf(m) }))
    .filter((x) => x.t.length > 0)
  if (embedder && textCandidates.length > 0) {
    try {
      const results = await classifyIntent(
        textCandidates.map((x) => x.t),
        embedder,
      )
      textCandidates.forEach((x, i) => {
        intentById.set(String(x.m.id ?? i), results[i])
      })
    } catch {
      intentById = new Map()
    }
  }

  const getIntent = (m: any) => intentById.get(String(m?.id ?? ''))

  if (pendingInbound && lastInbound) {
    const relevant =
      inboundAfterMine.length > 0 ? inboundAfterMine : [lastInbound]
    const latest = relevant[relevant.length - 1]

    // pick evidence: mentioned me/all > actionable by intent > latest
    let evidence = latest
    let evidenceIntent: Intent | null = getIntent(latest)?.intent ?? null
    let evidenceScore = getIntent(latest)?.score ?? 0
    for (let i = relevant.length - 1; i >= 0; i--) {
      const m = relevant[i]
      const mention = mentionsSomeone(m, myMid)
      const it = getIntent(m)
      if (mention.me) {
        evidence = m
        evidenceIntent = 'actionable_request'
        evidenceScore = 1
        break
      }
      if (mention.all && isGroup) {
        evidence = m
        evidenceIntent = 'actionable_request'
        evidenceScore = 0.9
        break
      }
      if (
        it?.intent === 'actionable_request' &&
        (evidenceIntent !== 'actionable_request' || it.score >= evidenceScore)
      ) {
        evidence = m
        evidenceIntent = it.intent
        evidenceScore = it.score
      } else if (
        !evidenceIntent &&
        it &&
        it.intent !== 'informational_or_ack'
      ) {
        evidence = m
        evidenceIntent = it.intent
        evidenceScore = it.score
      }
    }

    const mention = mentionsSomeone(evidence, myMid)
    const actionable =
      mention.me ||
      mention.all ||
      evidenceIntent === 'actionable_request' ||
      (evidenceIntent === null && textOf(evidence).length === 0)
    const directedOther =
      isGroup && evidenceIntent === 'directed_to_other' && !mention.me

    if (isGroup) {
      if (mention.me || (mention.all && actionable)) {
        return {
          ball: 'mine',
          confidence: 'high',
          reasons: [
            mention.me ? 'mentioned_me' : 'mentioned_all',
            'semantic_actionable',
            'unread_or_pending',
          ],
          lastInbound: evidence,
          lastMine,
          evidence,
        }
      }
      if (directedOther) {
        return {
          ball: 'none',
          confidence: 'medium',
          reasons: ['group_addressed_to_other'],
          lastInbound: latest,
          lastMine,
          evidence,
        }
      }
      if (actionable) {
        return {
          ball: mention.all ? 'mine' : 'team',
          confidence: evidenceIntent ? 'medium' : 'medium',
          reasons: [
            mention.all ? 'mentioned_all' : 'group_actionable',
            'semantic_actionable',
            'unread_or_pending',
          ],
          lastInbound: evidence,
          lastMine,
          evidence,
        }
      }
      if (evidenceIntent === 'informational_or_ack') {
        return {
          ball: 'none',
          confidence: 'medium',
          reasons: ['group_informational'],
          lastInbound: latest,
          lastMine,
          evidence: latest,
        }
      }
      return {
        ball: 'team',
        confidence: 'low',
        reasons: ['group_inbound_pending', 'unread_or_pending'],
        lastInbound: latest,
        lastMine,
        evidence: latest,
      }
    }

    // 1:1
    if (actionable) {
      return {
        ball: 'mine',
        confidence:
          evidenceIntent === 'actionable_request' || mention.me
            ? 'high'
            : 'medium',
        reasons: ['semantic_actionable', 'unread_or_pending'],
        lastInbound: evidence,
        lastMine,
        evidence,
      }
    }
    if (evidenceIntent === 'informational_or_ack') {
      return {
        ball: 'none',
        confidence: 'medium',
        reasons: ['semantic_informational'],
        lastInbound: latest,
        lastMine,
        evidence: latest,
      }
    }
    return {
      ball: 'mine',
      confidence: 'medium',
      reasons: ['inbound_pending'],
      lastInbound: latest,
      lastMine,
      evidence: latest,
    }
  }

  // No pending inbound: last is mine
  if (lastMine && isMe(last, myMid)) {
    const it = getIntent(last)
    if (it?.intent === 'actionable_request') {
      return {
        ball: 'theirs',
        confidence: 'medium',
        reasons: ['i_awaiting_reply', 'semantic_actionable'],
        lastInbound,
        lastMine: last,
        evidence: last,
      }
    }
    return {
      ball: 'theirs',
      confidence: 'high',
      reasons: ['i_replied_last'],
      lastInbound,
      lastMine: last,
      evidence: last,
    }
  }

  return {
    ball: isGroup ? 'team' : 'none',
    confidence: 'low',
    reasons: ['no_pending'],
    lastInbound,
    lastMine,
    evidence: last,
  }
}

/**
 * Analyze conversations for "ball in my court" action items.
 */
export async function handleGetActionItems(
  service: LineProtocolService,
  args: {
    limit?: number
    perChat?: number
    includeRead?: boolean
    unreadOnly?: boolean
    chatId?: string
  },
) {
  const excluded = getExcludedChatIds()
  const myMid = service.profile?.mid ?? null
  const perChat = Math.min(Math.max(args.perChat ?? 30, 10), 80)

  let boxes: any[]
  if (args.chatId) {
    let unreadCount = 0
    try {
      const all = await listBoxesByRecency(service, { withUnreadCount: true })
      const found = all.find((b: any) => b.id === args.chatId)
      unreadCount = found?.unreadCount ?? 0
    } catch {}
    boxes = [{ id: args.chatId, unreadCount }]
  } else {
    const all = await listBoxesByRecency(service, { withUnreadCount: true })
    boxes = all.filter((box: any) => {
      if (!box.id || excluded.has(box.id)) return false
      if (args.unreadOnly || args.includeRead === false) {
        return (box.unreadCount ?? 0) > 0
      }
      return true
    })
  }

  const limit = args.limit && args.limit > 0 ? args.limit : boxes.length
  const selected = boxes.slice(0, limit)
  const names = await resolveConversationNames(
    service,
    selected.map((b: any) => b.id),
  )
  const acc = createPhiAccumulator()

  // AI-native semantic classifier (local embeddings). If unavailable, analysis
  // still proceeds on structural signals (recency/unread/mentions/flow).
  let embedder: Embedder | null = null
  try {
    embedder = getDefaultEmbedder()
  } catch {
    embedder = null
  }

  const items = await Promise.all(
    selected.map(async (box: any) => {
      const chatId = box.id
      const chatName = names.get(chatId) ?? null
      const isGroup = chatId.startsWith('c') || chatId.startsWith('r')
      const unreadCount = box.unreadCount ?? 0
      const fetchCount = Math.min(Math.max(perChat, unreadCount + 15, 30), 120)
      const messages = await service.getRecentMessages(chatId, fetchCount)
      const senderNames = await resolveSenderNames(
        service,
        messages.map((m: any) => m.from).filter(Boolean),
      )
      const verdict = await classifyBall(
        messages,
        myMid,
        isGroup,
        unreadCount,
        embedder,
      )
      const evidence =
        verdict.evidence || verdict.lastInbound || verdict.lastMine
      const preview = maskInto(acc, messagePreview(evidence))
      const reasons = verdict.reasons.filter(Boolean)
      return {
        chatId,
        name: chatName,
        unreadCount,
        isGroup,
        ball: verdict.ball,
        confidence: verdict.confidence,
        reasons,
        lastMessage: evidence
          ? {
              id: String(evidence.id ?? ''),
              from: evidence.from ?? null,
              fromName: senderNames.get(evidence.from) ?? null,
              text: preview,
              createdTime: messageTimestamp(evidence),
              isSelf: isMe(evidence, myMid),
              contentType: Number(evidence.contentType ?? 0),
            }
          : null,
      }
    }),
  )

  const rankBall: Record<Ball, number> = {
    mine: 0,
    team: 1,
    unknown: 2,
    theirs: 3,
    none: 4,
  }
  const rankConf: Record<Confidence, number> = { high: 0, medium: 1, low: 2 }
  items.sort((a, b) => {
    const da = rankBall[a.ball] - rankBall[b.ball]
    if (da !== 0) return da
    const du = (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0)
    if (du !== 0) return du
    const dc = rankConf[a.confidence] - rankConf[b.confidence]
    if (dc !== 0) return dc
    return (b.lastMessage?.createdTime ?? 0) - (a.lastMessage?.createdTime ?? 0)
  })

  const content: any[] = [
    {
      type: 'text' as const,
      text: toonText({
        summary: {
          scanned: items.length,
          ballMine: items.filter((i) => i.ball === 'mine').length,
          ballTeam: items.filter((i) => i.ball === 'team').length,
          ballTheirs: items.filter((i) => i.ball === 'theirs').length,
        },
        items,
      }),
    },
  ]
  if (selected.length < boxes.length) {
    content.push({
      type: 'text' as const,
      text: `Showing ${selected.length} of ${boxes.length} conversations (limit).`,
    })
  }
  const note = phiNote(acc)
  if (note) content.push(note)
  return { content }
}
