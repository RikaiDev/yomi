/**
 * Yomi personal style profile — "digital twin" style card for the user.
 *
 * Returns a compact, token-efficient style card so an AI can draft LINE
 * replies that match the user's actual voice: phrasing, message segmentation
 * (bursting), emoji usage, and sticker habits (when/how/which stickers).
 *
 * Data comes from the local search index only (no network). The profile is
 * computed on demand from the user's own sent messages (fromMid = user).
 */

import { getDb } from './store.js'

interface StickerSample {
  stickerId: string
  packageId: string
  /** Sticker text/alt if available in index. */
  text: string | null
  chatId: string
  createdTime: number | null
}

export interface StyleCard {
  /** Messages analyzed for text style. */
  textSampleSize: number
  /** Stickers analyzed. */
  stickerSampleSize: number
  /** Compact natural-language style guide (primary, token-efficient). */
  guide: string[]
  /** Quantitative signals (small). */
  signals: {
    avgChars: number
    medianChars: number
    /** Fraction of messages with emoji. */
    emojiRate: number
    /** Fraction of messages that are greetings/openers. */
    greetingRate: number
    /** Fraction of messages that are closings/gratitude. */
    closingRate: number
    /** Fraction ending with question mark. */
    questionRate: number
    /** Typical burst size: messages sent within 60s of previous in same chat. */
    burstTypical: number
    /** Median gap in seconds between messages in a burst (<60s gaps). */
    burstGapSec: number
    /** Fraction of user activity that is stickers (vs text). */
    stickerRate: number
    formality: 'casual' | 'neutral' | 'formal'
  }
  /** Short examples of how the user actually writes (few-shot, token-capped). */
  examples: string[]
  /** Per-chat nuances for the target chat (when chatId provided). */
  chat?: {
    chatId: string
    chatName: string | null
    textSampleSize: number
    stickerSampleSize: number
    notes: string[]
    examples: string[]
    topStickers: { packageId: string; stickerId: string; count: number }[]
  }
  /** Global top stickers the user sends. */
  topStickers: { packageId: string; stickerId: string; count: number }[]
  /** Guidance for when to use stickers and how to segment. */
  behavior: {
    segmentation: string
    stickerUsage: string
  }
}

interface MsgRow {
  chatId: string
  chatName: string | null
  text: string
  createdTime: number | null
  contentType: number
  stickerId: string | null
  stickerPackageId: string | null
}

const GREETING_RE =
  /^(?:哈囉|哈嚕|嗨|早安|午安|晚安|你好|您好|安安|hi\b|hello\b|hey\b|morning\b)/i
const CLOSING_RE =
  /(?:謝謝|多謝|感謝|辛苦|thanks?\b|thank\s*you|thx\b|掰|再見|bye\b|晚安|改天見|先這樣|88)/i
const EMOJI_RE =
  /(?:[\u{1F300}-\u{1FAFF}]|[\u{2600}-\u{27BF}]|[\u{FE00}-\u{FE0F}])/u
const CASUAL_RE =
  /(?:哈哈+|呵呵|嘿嘿|www+|XD|xD|lol|欸|耶|喔+|哦+|啦|囉|嘛|齁|ㄏㄏ|QQ|哭哭|www)/i
const FORMAL_RE = /(?:您好|敬請|煩請|惠請|懇請|此致|敬上|順頌|貴|承蒙|謹)/

function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2)
}

function queryUserMessages(
  userMid: string,
  chatId?: string,
  limit = 500,
): MsgRow[] {
  const handle = getDb()
  if (chatId) {
    return handle
      .prepare<MsgRow>(
        `SELECT chatId, chatName, text, createdTime, contentType, stickerId, stickerPackageId
         FROM messages
         WHERE fromMid = $userMid AND chatId = $chatId
         ORDER BY createdTime DESC NULLS LAST
         LIMIT $limit`,
      )
      .all({ $userMid: userMid, $chatId: chatId, $limit: limit })
  }
  return handle
    .prepare<MsgRow>(
      `SELECT chatId, chatName, text, createdTime, contentType, stickerId, stickerPackageId
       FROM messages
       WHERE fromMid = $userMid
       ORDER BY createdTime DESC NULLS LAST
       LIMIT $limit`,
    )
    .all({ $userMid: userMid, $limit: limit })
}

function computeBurst(rows: MsgRow[]): { typical: number; gapSec: number } {
  // Group by chat, ascending time
  const byChat = new Map<string, number[]>()
  for (const r of rows) {
    if (r.createdTime == null) continue
    const arr = byChat.get(r.chatId) ?? []
    arr.push(r.createdTime)
    byChat.set(r.chatId, arr)
  }
  const burstSizes: number[] = []
  const gaps: number[] = []
  for (const times of byChat.values()) {
    times.sort((a, b) => a - b)
    let size = 1
    for (let i = 1; i < times.length; i++) {
      const gap = (times[i] - times[i - 1]) / 1000
      if (gap <= 60) {
        size++
        gaps.push(Math.round(gap))
      } else {
        if (size > 0) burstSizes.push(size)
        size = 1
      }
    }
    burstSizes.push(size)
  }
  if (burstSizes.length === 0) return { typical: 1, gapSec: 0 }
  // typical = median burst size (cap influence)
  return { typical: median(burstSizes), gapSec: gaps.length ? median(gaps) : 0 }
}

function topStickers(
  rows: MsgRow[],
  limit = 8,
): { packageId: string; stickerId: string; count: number }[] {
  const freq = new Map<string, number>()
  for (const r of rows) {
    if (r.contentType === 7 && r.stickerId && r.stickerPackageId) {
      const k = `${r.stickerPackageId}:${r.stickerId}`
      freq.set(k, (freq.get(k) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([k, count]) => {
      const [packageId, stickerId] = k.split(':')
      return { packageId, stickerId, count }
    })
}

function pickExamples(texts: string[], max = 6, maxChars = 600): string[] {
  const out: string[] = []
  let total = 0
  // Prefer varied lengths
  const sorted = [...texts].sort((a, b) => a.length - b.length)
  const picks = [
    sorted[0],
    sorted[Math.floor(sorted.length * 0.25)],
    sorted[Math.floor(sorted.length * 0.5)],
    sorted[Math.floor(sorted.length * 0.75)],
    sorted[sorted.length - 1],
    sorted[Math.floor(sorted.length * 0.1)],
  ].filter(Boolean) as string[]
  const seen = new Set<string>()
  for (const t of picks) {
    if (seen.has(t)) continue
    seen.add(t)
    const s = t.length > 120 ? `${t.slice(0, 117)}…` : t
    if (total + s.length > maxChars) break
    out.push(s)
    total += s.length
    if (out.length >= max) break
  }
  return out
}

function detectFormality(
  texts: string[],
  emojiRate: number,
  stickerRate: number,
): 'casual' | 'neutral' | 'formal' {
  let formal = 0
  let casual = 0
  for (const t of texts) {
    if (FORMAL_RE.test(t)) formal++
    if (CASUAL_RE.test(t)) casual++
  }
  if (emojiRate > 0.15) casual += Math.ceil(texts.length * 0.2)
  if (stickerRate > 0.2) casual += Math.ceil(texts.length * 0.1)
  if (formal > casual && formal > texts.length * 0.1) return 'formal'
  if (casual > formal) return 'casual'
  return 'neutral'
}

function buildGuide(
  s: StyleCard['signals'],
  burst: { typical: number; gapSec: number },
  _topStickerCount: number,
): string[] {
  const g: string[] = []
  g.push(`語氣:${s.formality}; 平均${s.avgChars}字/則(中位${s.medianChars})`)
  if (burst.typical >= 2) {
    g.push(
      `分段:常連發${burst.typical}則短訊(間隔約${burst.gapSec}s),把想法拆成多則而非一大段`,
    )
  } else {
    g.push(`分段:多為單則完整訊息`)
  }
  if (s.emojiRate > 0.05)
    g.push(`emoji:偶爾使用(約${Math.round(s.emojiRate * 100)}%)`)
  else g.push(`emoji:很少或不用`)
  if (s.stickerRate > 0.05) {
    g.push(
      `貼圖:會用(約佔${Math.round(s.stickerRate * 100)}%訊息); 常用貼圖見 topStickers, 回覆時可視情境搭配同款/同系列`,
    )
  } else {
    g.push(`貼圖:少用`)
  }
  if (s.greetingRate > 0.05) g.push(`開場:常帶招呼語`)
  if (s.closingRate > 0.1) g.push(`收尾:常帶致謝/收尾語`)
  if (s.questionRate > 0.15) g.push(`提問:常用問句`)
  g.push(`原則:完全模仿語氣/用詞/分段節奏與貼圖習慣,不加模板客套,不改寫成AI腔`)
  return g
}

function analyze(rows: MsgRow[], chatId?: string): StyleCard {
  const textRows = rows.filter(
    (r) =>
      r.contentType !== 7 && typeof r.text === 'string' && r.text.length > 0,
  )
  const stickerRows = rows.filter((r) => r.contentType === 7)
  const texts = textRows.map((r) => r.text)
  const lens = texts.map((t) => t.length)
  const avgChars = texts.length
    ? Math.round(lens.reduce((a, b) => a + b, 0) / lens.length)
    : 0
  const medChars = median(lens)
  const emojiRate = texts.length
    ? texts.filter((t) => EMOJI_RE.test(t)).length / texts.length
    : 0
  const greetingRate = texts.length
    ? texts.filter((t) => GREETING_RE.test(t)).length / texts.length
    : 0
  const closingRate = texts.length
    ? texts.filter((t) => CLOSING_RE.test(t)).length / texts.length
    : 0
  const questionRate = texts.length
    ? texts.filter((t) => /[？?]/.test(t)).length / texts.length
    : 0
  const totalActs = textRows.length + stickerRows.length
  const stickerRate = totalActs ? stickerRows.length / totalActs : 0
  const burst = computeBurst(rows)
  const formality = detectFormality(texts, emojiRate, stickerRate)
  const signals = {
    avgChars,
    medianChars: medChars,
    emojiRate: Math.round(emojiRate * 100) / 100,
    greetingRate: Math.round(greetingRate * 100) / 100,
    closingRate: Math.round(closingRate * 100) / 100,
    questionRate: Math.round(questionRate * 100) / 100,
    burstTypical: burst.typical,
    burstGapSec: burst.gapSec,
    stickerRate: Math.round(stickerRate * 100) / 100,
    formality,
  }
  const globalStickers = topStickers(rows)
  const guide = buildGuide(signals, burst, globalStickers.length)
  const card: StyleCard = {
    textSampleSize: textRows.length,
    stickerSampleSize: stickerRows.length,
    guide,
    signals,
    examples: pickExamples(texts, 6, 500),
    topStickers: globalStickers,
    behavior: {
      segmentation:
        burst.typical >= 2
          ? `把回覆拆成約${burst.typical}則短訊依序送出(每則間隔幾秒),模擬連發;避免合併成一大段`
          : '通常單則回覆即可',
      stickerUsage:
        stickerRate > 0.05 && globalStickers.length
          ? `可在合適情境單獨送貼圖或文字後補貼圖;優先使用 topStickers 中的 stickerId/packageId(用 send_sticker)`
          : '預設不加貼圖,除非對話情境明顯需要且使用者慣用',
    },
  }

  if (chatId) {
    const chatRows = rows.filter((r) => r.chatId === chatId)
    const chatText = chatRows.filter((r) => r.contentType !== 7 && r.text)
    const chatStk = chatRows.filter((r) => r.contentType === 7)
    const chatName = chatRows[0]?.chatName ?? null
    const chatBurst = computeBurst(chatRows)
    const notes: string[] = []
    if (chatText.length) {
      const clens = chatText.map((r) => r.text.length)
      notes.push(
        `此對話:平均${Math.round(clens.reduce((a, b) => a + b, 0) / clens.length)}字/則`,
      )
      if (chatBurst.typical >= 2)
        notes.push(`此對話常連發${chatBurst.typical}則`)
    }
    if (chatStk.length) notes.push(`此對話有貼圖互動(${chatStk.length}則)`)
    card.chat = {
      chatId,
      chatName,
      textSampleSize: chatText.length,
      stickerSampleSize: chatStk.length,
      notes,
      examples: pickExamples(
        chatText.map((r) => r.text),
        4,
        320,
      ),
      topStickers: topStickers(chatRows, 5),
    }
  }

  return card
}

/**
 * Build a compact style card for the user. Pass chatId to include per-chat
 * nuances (segmentation/sticker habits can differ by conversation).
 */
export function getStyleCard(
  userMid: string,
  chatId?: string,
): StyleCard | null {
  const rows = queryUserMessages(userMid, chatId, 600)
  if (rows.length === 0) {
    // If chat-scoped had nothing, try global
    if (chatId) {
      const global = queryUserMessages(userMid, undefined, 600)
      if (global.length === 0) return null
      return analyze(global, chatId)
    }
    return null
  }
  // If chat-scoped, also include global context for better card
  if (chatId) {
    const global = queryUserMessages(userMid, undefined, 400)
    // Use global for base style; enrich chat section from actual chat rows.
    const card = analyze(global, chatId)
    // Ensure chat section uses actual chat rows
    const chatRows = rows
    const chatText = chatRows.filter((r) => r.contentType !== 7 && r.text)
    const chatStk = chatRows.filter((r) => r.contentType === 7)
    const chatBurst = computeBurst(chatRows)
    const notes: string[] = []
    if (chatText.length) {
      const clens = chatText.map((r) => r.text.length)
      notes.push(
        `此對話:平均${Math.round(clens.reduce((a, b) => a + b, 0) / clens.length)}字/則, ${chatText.length}則文字`,
      )
      if (chatBurst.typical >= 2)
        notes.push(`此對話常連發${chatBurst.typical}則`)
    }
    if (chatStk.length) notes.push(`此對話貼圖${chatStk.length}則`)
    card.chat = {
      chatId,
      chatName: chatRows[0]?.chatName ?? null,
      textSampleSize: chatText.length,
      stickerSampleSize: chatStk.length,
      notes,
      examples: pickExamples(
        chatText.map((r) => r.text),
        4,
        320,
      ),
      topStickers: topStickers(chatRows, 5),
    }
    return card
  }
  return analyze(rows)
}

// Internal aliases kept for potential future use
type _StyleProfile = StyleCard
function _buildStyleProfile(
  userMid: string,
  chatId?: string,
): StyleCard | null {
  return getStyleCard(userMid, chatId)
}
void _buildStyleProfile
