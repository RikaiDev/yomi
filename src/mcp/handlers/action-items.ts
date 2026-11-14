/**
 * "Ball in court" analysis — generalized, heuristic action-item detection over
 * LINE conversations (who likely needs to act next).
 *
 * This is intentionally a lightweight, deterministic first pass: it does not
 * read illocutionary force perfectly (no LLM), so it exposes signals/reasons
 * and a confidence level for the agent/user to judge. It answers "who likely
 * needs to act next?" from recent message flow:
 * - latest meaningful message from the other side that looks like a request /
 *   question / assignment / mention -> likely on me (or on a named member).
 * - latest meaningful message from me (and no later inbound request) -> on them.
 * - broadcast/official/notification traffic -> none.
 *
 * Purely read-only: no marks-read, no index writes.
 */

import { CONTENT_TYPE } from '../../line/core/constants.js'
import { listBoxesByRecency } from '../../line/core/message-box-recency.js'
import { sanitizeMessagePreview } from '../../line/core/message-preview.js'
import { decryptLineMessage } from '../../line/core/message-query-service.js'
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
}

function messageTimestamp(message: any): number {
  return Number(message?.deliveredTime || message?.createdTime || 0)
}

function isMeaningful(message: any): boolean {
  const ct = Number(message?.contentType ?? 0)
  // system/noise types carry no conversational obligation
  const noise = new Set([
    CONTENT_TYPE.NONE,
    CONTENT_TYPE.PRESENCE,
    CONTENT_TYPE.GROUPBOARD,
    CONTENT_TYPE.POSTNOTIFICATION,
    CONTENT_TYPE.CHATEVENT,
  ])
  if (noise.has(ct)) return false
  const text = String(message?.text ?? '').trim()
  if (text.length > 0 && text !== '[加密訊息]' && text !== '[社群訊息]')
    return true
  // media/sticker/file/location/contact can carry an ask; treat as meaningful
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

function looksActionable(text: string): { hit: boolean; cues: string[] } {
  const t = text.trim()
  if (!t) return { hit: false, cues: [] }
  const cues: string[] = []
  if (/[?？]/.test(t)) cues.push('question')
  const patterns: Array<[RegExp, string]> = [
    [/(請|麻煩|幫我|幫忙|可否|能否|是否|方便|拜託|勞煩|還請)/u, 'request'],
    [
      /(確認|提供|回覆|回報|告知|更新|傳|給我|補|修|處理|安排|協助|開立|報價|匯款|付款|簽|送出|報名|填)/u,
      'action',
    ],
    [/(什麼時候|何時|哪天|幾點|有空|要不要|可以嗎|好嗎)/u, 'question'],
    [/(提醒|記得|截止|期限|到期|今天|明天|盡快|asap)/iu, 'time_sensitive'],
  ]
  for (const [re, label] of patterns) {
    if (re.test(t) && !cues.includes(label)) cues.push(label)
  }
  return { hit: cues.length > 0, cues }
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
  return /通知|官方|LINE|Bank|Pay|購物|禮物|TV|TODAY|錢包|發票|貼圖|Store|GAME|社群|商家|Service|客服|公告|Rangers|抽獎|優惠/u.test(
    n,
  )
}

function classifyBall(
  messages: any[],
  myMid: string | null,
  chatId: string,
  chatName: string | null,
  isGroup: boolean,
): BallResult & { lastInbound?: any; lastMine?: any } {
  const meaningful = messages.filter(isMeaningful)
  if (meaningful.length === 0) {
    return {
      ball: 'none',
      confidence: 'low',
      reasons: ['no_meaningful_message'],
    }
  }
  // messages are newest-first in digest-like usage? getRecentMessages returns recent in time order usually;
  // normalize to time-asc then inspect tail.
  const asc = [...meaningful].sort(
    (a, b) => messageTimestamp(a) - messageTimestamp(b),
  )
  const last = asc[asc.length - 1]
  const lastIsMe = myMid ? last.from === myMid : false
  const official = isLikelyOfficial(chatId, chatName)

  const lastInbound = [...asc]
    .reverse()
    .find((m) => (myMid ? m.from !== myMid : true))
  const lastMine = [...asc]
    .reverse()
    .find((m) => (myMid ? m.from === myMid : false))

  if (official && !isGroup) {
    // official 1:1: actionable only if looks like a personal transaction alert needing action
    const t = String(lastInbound?.text ?? '')
    const act = looksActionable(t)
    if (!lastIsMe && act.hit) {
      return {
        ball: 'mine',
        confidence: 'low',
        reasons: ['official_but_actionable', ...act.cues],
        lastInbound,
        lastMine,
      }
    }
    return {
      ball: 'none',
      confidence: 'medium',
      reasons: ['official_or_notification'],
      lastInbound,
      lastMine,
    }
  }

  if (lastIsMe) {
    // I spoke last: ball usually theirs, unless I asked a question (awaiting answer)
    const myText = String(last.text ?? '')
    const act = looksActionable(myText)
    if (act.hit) {
      return {
        ball: 'theirs',
        confidence: 'medium',
        reasons: ['i_asked_waiting_reply', ...act.cues],
        lastInbound,
        lastMine: last,
      }
    }
    return {
      ball: 'theirs',
      confidence: 'high',
      reasons: ['i_replied_last'],
      lastInbound,
      lastMine: last,
    }
  }

  // inbound last
  const inText = String(last.text ?? '')
  const act = looksActionable(inText)
  const mention = mentionsSomeone(last, myMid)
  if (mention.me) {
    return {
      ball: 'mine',
      confidence: 'high',
      reasons: ['mentioned_me', ...act.cues],
      lastInbound: last,
      lastMine,
    }
  }
  if (isGroup) {
    if (mention.all) {
      return {
        ball: 'mine',
        confidence: 'medium',
        reasons: ['mentioned_all', ...act.cues],
        lastInbound: last,
        lastMine,
      }
    }
    if (act.hit) {
      return {
        ball: 'team',
        confidence: 'medium',
        reasons: ['group_inbound_actionable', ...act.cues],
        lastInbound: last,
        lastMine,
      }
    }
    return {
      ball: 'none',
      confidence: 'low',
      reasons: ['group_inbound_no_clear_ask'],
      lastInbound: last,
      lastMine,
    }
  }

  // 1:1 inbound
  if (act.hit) {
    return {
      ball: 'mine',
      confidence: 'high',
      reasons: ['inbound_actionable', ...act.cues],
      lastInbound: last,
      lastMine,
    }
  }
  // short ack / FYI inbound: low-confidence mine to review
  return {
    ball: 'mine',
    confidence: 'low',
    reasons: ['inbound_unanswered'],
    lastInbound: last,
    lastMine,
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
  const perChat = Math.min(Math.max(args.perChat ?? 20, 5), 50)

  let boxes: any[]
  if (args.chatId) {
    boxes = [{ id: args.chatId, unreadCount: 0 }]
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
      const raw = await service.getRecentMessages(chatId, perChat)
      const messages = service.e2eeManager
        ? await Promise.all(
            raw.map((m: any) =>
              decryptLineMessage(service.e2eeManager, m, chatId),
            ),
          )
        : raw
      const senderNames = await resolveSenderNames(
        service,
        messages.map((m: any) => m.from).filter(Boolean),
      )
      const verdict = classifyBall(messages, myMid, chatId, chatName, isGroup)
      const last = verdict.lastInbound || verdict.lastMine
      const preview = maskInto(acc, sanitizeMessagePreview(last?.text ?? null))
      return {
        chatId,
        name: chatName,
        unreadCount: box.unreadCount ?? 0,
        isGroup,
        ball: verdict.ball,
        confidence: verdict.confidence,
        reasons: verdict.reasons,
        lastMessage: last
          ? {
              id: String(last.id ?? ''),
              from: last.from ?? null,
              fromName: senderNames.get(last.from) ?? null,
              text: preview,
              createdTime: messageTimestamp(last),
              isSelf: myMid ? last.from === myMid : false,
            }
          : null,
      }
    }),
  )

  // sort: mine/team first, then unread, then recency
  const rankBall: Record<Ball, number> = {
    mine: 0,
    team: 1,
    unknown: 2,
    theirs: 3,
    none: 4,
  }
  items.sort((a, b) => {
    const da = rankBall[a.ball] - rankBall[b.ball]
    if (da !== 0) return da
    const du = (b.unreadCount > 0 ? 1 : 0) - (a.unreadCount > 0 ? 1 : 0)
    if (du !== 0) return du
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
