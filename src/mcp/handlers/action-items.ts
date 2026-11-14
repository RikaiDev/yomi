/**
 * "Ball in court" analysis — generalized, heuristic action-item detection over
 * LINE conversations (who likely needs to act next).
 *
 * Deterministic, read-only analysis over recent message flow. It does not read
 * illocutionary force perfectly (no LLM), so it returns reasons, confidence,
 * and evidence messages for inspection. It is designed to be useful by default:
 * - picks the latest actionable inbound evidence (question/request/mention),
 *   not just the last attachment in a burst
 * - treats unread/inbound-after-my-last-reply as pending on my side
 * - distinguishes official/broadcast traffic from personal 1:1 requests
 * - surfaces group mentions/requests as team/mine with attribution
 *
 * Purely read-only: no marks-read, no index writes.
 */

import { CONTENT_TYPE } from '../../line/core/constants.js'
import { listBoxesByRecency } from '../../line/core/message-box-recency.js'
import { sanitizeMessagePreview } from '../../line/core/message-preview.js'
import type { LineProtocolService } from '../../line/core/service.js'
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
  const meaningfulTypes = new Set([
    CONTENT_TYPE.IMAGE,
    CONTENT_TYPE.VIDEO,
    CONTENT_TYPE.AUDIO,
    CONTENT_TYPE.FILE,
    CONTENT_TYPE.LOCATION,
    CONTENT_TYPE.CONTACT,
    CONTENT_TYPE.STICKER,
    CONTENT_TYPE.RICH,
    CONTENT_TYPE.FLEX,
  ])
  return meaningfulTypes.has(ct)
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

function looksActionable(text: string): { hit: boolean; cues: string[] } {
  const t = text.trim()
  if (!t) return { hit: false, cues: [] }
  const cues: string[] = []
  if (/[?？]/.test(t)) cues.push('question')
  const patterns: Array<[RegExp, string]> = [
    [/(請|麻煩|幫我|幫忙|可否|能否|是否|方便|拜託|勞煩|還請)/u, 'request'],
    [
      /(確認|提供|回覆|回報|告知|更新|傳|給我|補|修|處理|安排|協助|開立|報價|匯款|付款|簽|送出|報名|填|聯繫|電話)/u,
      'action',
    ],
    [/(什麼時候|何時|哪天|幾點|有空|要不要|可以嗎|好嗎|嗎$)/u, 'question'],
    [/(提醒|記得|截止|期限|到期|今天|明天|盡快|asap)/iu, 'time_sensitive'],
  ]
  for (const [re, label] of patterns) {
    if (re.test(t) && !cues.includes(label)) cues.push(label)
  }
  return { hit: cues.length > 0, cues }
}

function looksNonActionableAck(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return /^(好|好的|ok|OK|收到|了解|瞭解|謝謝|感謝|感恩|辛苦了|沒問題|可以|👌|👍|🙏)+[!！。.~～…]*$/u.test(
    t,
  )
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

function isLikelyOfficial(chatId: string, name: string | null): boolean {
  if (!chatId.startsWith('u')) return false
  const n = name ?? ''
  return /(通知|官方|LINE\s|LINE$|Bank|Pay|購物|禮物|TV|TODAY|錢包|發票|貼圖|Store|GAME|社群|商家|Service|客服|公告|Rangers|抽獎|優惠|POINTS|GO\b|MINI App)/iu.test(
    n,
  )
}

function messagePreview(message: any): string {
  const text = sanitizeMessagePreview(textOf(message))
  if (text) return text
  const label = contentTypeLabel(Number(message?.contentType ?? 0))
  return label ? `[${label}]` : ''
}

function classifyBall(
  messages: any[],
  myMid: string | null,
  chatId: string,
  chatName: string | null,
  isGroup: boolean,
  unreadCount: number,
): BallResult & { lastInbound?: any; lastMine?: any } {
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

  const official = isLikelyOfficial(chatId, chatName)
  const pendingInbound = unreadCount > 0 || inboundAfterMine.length > 0

  if (official && !isGroup) {
    const actionableInbound = [...inboundAfterMine]
      .reverse()
      .find((m) => looksActionable(textOf(m)).hit)
    if (pendingInbound && actionableInbound) {
      const cues = looksActionable(textOf(actionableInbound)).cues
      return {
        ball: 'mine',
        confidence: 'medium',
        reasons: ['official_but_actionable', ...cues],
        lastInbound: actionableInbound,
        lastMine,
        evidence: actionableInbound,
      }
    }
    return {
      ball: 'none',
      confidence: unreadCount > 0 ? 'medium' : 'high',
      reasons: ['official_or_notification'],
      lastInbound,
      lastMine,
      evidence: lastInbound ?? last,
    }
  }

  // If there is inbound after my last reply (or unread), evaluate that inbound.
  if (pendingInbound && lastInbound) {
    const relevant =
      inboundAfterMine.length > 0 ? inboundAfterMine : [lastInbound]
    const latest = relevant[relevant.length - 1]
    const actionable =
      [...relevant].reverse().find((m) => {
        const t = textOf(m)
        return (
          looksActionable(t).hit ||
          mentionsSomeone(m, myMid).me ||
          mentionsSomeone(m, myMid).all
        )
      }) ?? latest
    const text = textOf(actionable)
    const act = looksActionable(text)
    const mention = mentionsSomeone(actionable, myMid)

    if (mention.me) {
      return {
        ball: 'mine',
        confidence: 'high',
        reasons: ['mentioned_me', ...act.cues, unreadCount > 0 ? 'unread' : ''],
        lastInbound: actionable,
        lastMine,
        evidence: actionable,
      }
    }
    if (isGroup) {
      if (mention.all) {
        return {
          ball: 'mine',
          confidence: 'high',
          reasons: [
            'mentioned_all',
            ...act.cues,
            unreadCount > 0 ? 'unread' : '',
          ],
          lastInbound: actionable,
          lastMine,
          evidence: actionable,
        }
      }
      if (act.hit) {
        return {
          ball: 'team',
          confidence: 'medium',
          reasons: [
            'group_inbound_actionable',
            ...act.cues,
            unreadCount > 0 ? 'unread' : '',
          ],
          lastInbound: actionable,
          lastMine,
          evidence: actionable,
        }
      }
      return {
        ball: 'team',
        confidence: 'low',
        reasons: [
          'group_inbound_pending',
          unreadCount > 0 ? 'unread' : 'inbound_unanswered',
        ],
        lastInbound: latest,
        lastMine,
        evidence: latest,
      }
    }

    if (act.hit) {
      return {
        ball: 'mine',
        confidence: 'high',
        reasons: [
          'inbound_actionable',
          ...act.cues,
          unreadCount > 0 ? 'unread' : '',
        ],
        lastInbound: actionable,
        lastMine,
        evidence: actionable,
      }
    }
    // 1:1 inbound without explicit cue: still pending reply/review
    return {
      ball: 'mine',
      confidence: unreadCount > 0 ? 'medium' : 'medium',
      reasons: [unreadCount > 0 ? 'unread_inbound' : 'inbound_unanswered'],
      lastInbound: latest,
      lastMine,
      evidence: latest,
    }
  }

  // No pending inbound: I spoke last
  if (lastMine && isMe(last, myMid)) {
    const myText = textOf(last)
    const act = looksActionable(myText)
    if (act.hit) {
      return {
        ball: 'theirs',
        confidence: 'medium',
        reasons: ['i_asked_waiting_reply', ...act.cues],
        lastInbound,
        lastMine: last,
        evidence: last,
      }
    }
    return {
      ball: 'theirs',
      confidence:
        looksNonActionableAck(myText) || myText.length === 0
          ? 'medium'
          : 'high',
      reasons: ['i_replied_last'],
      lastInbound,
      lastMine: last,
      evidence: last,
    }
  }

  // Fallbacks
  if (isGroup) {
    return {
      ball: 'none',
      confidence: 'low',
      reasons: ['group_no_pending'],
      lastInbound,
      lastMine,
      evidence: last,
    }
  }
  return {
    ball: 'none',
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

  const items = await Promise.all(
    selected.map(async (box: any) => {
      const chatId = box.id
      const chatName = names.get(chatId) ?? null
      const isGroup = chatId.startsWith('c') || chatId.startsWith('r')
      const unreadCount = box.unreadCount ?? 0
      const fetchCount = Math.min(Math.max(perChat, unreadCount + 15, 30), 120)
      const raw = await service.getRecentMessages(chatId, fetchCount)
      // getRecentMessages already returns decrypted messages; avoid re-decrypting.
      const messages = raw
      const senderNames = await resolveSenderNames(
        service,
        messages.map((m: any) => m.from).filter(Boolean),
      )
      const verdict = classifyBall(
        messages,
        myMid,
        chatId,
        chatName,
        isGroup,
        unreadCount,
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
