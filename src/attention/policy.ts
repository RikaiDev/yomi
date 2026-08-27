import { getDefaultEmbedder } from '../search/default-embedder.js'
import type { Embedder } from '../search/embedder.js'

export type AttentionTier = 'pending' | 'now' | 'today' | 'know' | 'filtered'
export interface AttentionInput {
  id: string
  text: string
  unreadCount: number
  isMuted: boolean
  isOfficial?: boolean
  hasMention?: boolean
  explicitPriority?: boolean
}
export interface AttentionResult {
  score: number
  tier: AttentionTier
  reason: string
}
type SemanticIntent =
  | 'reply'
  | 'deadline'
  | 'transaction'
  | 'important'
  | 'ordinary'
  | 'promotion'

// Natural-language intent descriptions, not trigger-word lists. The local
// transformer embeds both descriptions and messages; vector similarity does
// the classification even when no words literally overlap.
const INTENT_ANCHORS: Record<SemanticIntent, string[]> = {
  reply: [
    '對方直接向我提出問題、請求協助或要求我做決定，正在等待我的答覆',
    '工作交辦或需要我採取具體行動並回覆結果',
  ],
  deadline: [
    '有明確期限、會議時間、預約或即將到期的工作，需要及時處理',
    '緊急事故、風險或延誤，若不處理會造成後果',
  ],
  transaction: [
    '與我有關的帳單、付款、訂單、物流、航班、預約或帳號安全狀態異常',
    '交易失敗、行程變更或服務中斷，需要本人確認',
  ],
  important: [
    '與目前工作或生活直接相關的重要進度與公告，值得本人閱讀但不必回覆',
    '關鍵人物提供需要掌握的決策背景或狀態更新',
  ],
  ordinary: [
    '一般聊天、問候、貼圖、轉傳或沒有下一步的日常資訊',
    '內容與本人沒有直接關係，也不需要採取行動',
  ],
  promotion: [
    '品牌官方帳號寄送的行銷廣告、優惠活動、導購內容或宣傳文案',
    '用吸引人的疑問句包裝促銷活動，但並非真的在等待本人回答',
  ],
}

function dot(a: number[], b: number[]): number {
  let value = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) value += a[i] * b[i]
  return value
}

/** Transformer-embedding semantic classification followed only by explicit
 * product controls such as mute, mention and manual priority. */
export async function scoreAttentionBatch(
  inputs: AttentionInput[],
  embedder: Embedder = getDefaultEmbedder(),
): Promise<AttentionResult[]> {
  if (inputs.length === 0) return []
  const intents = Object.keys(INTENT_ANCHORS) as SemanticIntent[]
  const anchors = intents.flatMap((intent) =>
    INTENT_ANCHORS[intent].map((text) => ({ intent, text })),
  )
  const vectors = await embedder.embed([
    ...anchors.map((anchor) => anchor.text),
    ...inputs.map((input) => input.text || '無文字訊息'),
  ])
  const anchorVectors = vectors.slice(0, anchors.length)
  const messageVectors = vectors.slice(anchors.length)

  return inputs.map((input, inputIndex) => {
    if (input.isMuted) return { score: -100, tier: 'filtered', reason: 'muted' }
    if (input.explicitPriority)
      return { score: 70, tier: 'now', reason: 'manual_priority' }
    if (input.hasMention)
      return { score: 65, tier: 'now', reason: 'direct_mention' }
    if (
      input.isOfficial &&
      /^\[yomi:(?:image|rich|sticker|video|audio|file|extended_image)\]$/.test(
        input.text.trim(),
      )
    ) {
      return { score: 0, tier: 'filtered', reason: 'ordinary' }
    }

    const similarities = new Map<SemanticIntent, number>()
    anchors.forEach((anchor, anchorIndex) => {
      const similarity = dot(
        messageVectors[inputIndex],
        anchorVectors[anchorIndex],
      )
      similarities.set(
        anchor.intent,
        Math.max(similarities.get(anchor.intent) ?? -Infinity, similarity),
      )
    })
    const ranked = [...intents].sort(
      (a, b) => (similarities.get(b) ?? 0) - (similarities.get(a) ?? 0),
    )
    const intent = ranked[0]
    if (input.isOfficial && intent !== 'transaction') {
      return {
        score: -40,
        tier: 'filtered',
        reason: intent === 'promotion' ? 'promotion' : 'ordinary',
      }
    }
    const scoreByIntent: Record<SemanticIntent, number> = {
      reply: 55,
      deadline: 60,
      transaction: 50,
      important: 25,
      ordinary: 0,
      promotion: -40,
    }
    const score = scoreByIntent[intent]
    const tier: AttentionTier =
      score >= 55
        ? 'now'
        : score >= 35
          ? 'today'
          : score >= 20
            ? 'know'
            : 'filtered'
    const reasons: Record<SemanticIntent, string> = {
      reply: 'reply_expected',
      deadline: 'deadline',
      transaction: 'transaction',
      important: 'important',
      ordinary: 'ordinary',
      promotion: 'promotion',
    }
    return { score, tier, reason: reasons[intent] }
  })
}
