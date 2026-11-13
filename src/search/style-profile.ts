/**
 * Yomi personal style profile — extracts the user's own sent messages from
 * the search index and analyses their writing patterns so an AI assistant
 * can draft replies that sound like the user, not like a generic template.
 *
 * The profile is built on demand from the local search index (no external
 * API calls). It queries messages where `fromMid` matches the user's own
 * LINE MID, then computes:
 *
 * - **Message samples**: recent messages the user sent, grouped by chat,
 *   so the AI can see how they write in different contexts.
 * - **Style metrics**: average length, sentence patterns, emoji usage,
 *   greeting/farewell conventions, formality level, punctuation habits.
 * - **Chat-context pairs**: for a given chatId, the user's own messages
 *   in that conversation, so the AI can match the tone of that specific
 *   relationship.
 *
 * All data stays on-device (same SQLite index as search_messages).
 */

import { getDb } from './store.js'

/** A single message the user sent, with enough context for style analysis. */
export interface StyleSample {
  chatId: string
  chatName: string | null
  text: string
  createdTime: number | null
}

/** Aggregate style metrics computed from the user's sent messages. */
export interface StyleMetrics {
  /** Total user-sent messages in the index. */
  totalMessages: number
  /** Average character length per message. */
  avgLength: number
  /** Fraction of messages containing emoji (0-1). */
  emojiRatio: number
  /** Fraction of messages containing a greeting word. */
  greetingRatio: number
  /** Fraction of messages containing a farewell or gratitude word. */
  farewellRatio: number
  /** Fraction of messages ending with a period/full stop. */
  periodEndingRatio: number
  /** Fraction of messages ending with an exclamation mark. */
  exclamationRatio: number
  /** Fraction of messages ending with a question mark. */
  questionRatio: number
  /** Most common message length (mode, bucketed by 10). */
  commonLengthBucket: string
  /** Top keywords / phrases the user uses frequently (simple frequency). */
  frequentPhrases: { phrase: string; count: number }[]
  /** Detected formality: "casual" | "neutral" | "formal". */
  formality: 'casual' | 'neutral' | 'formal'
}

/** Full style profile returned to the AI assistant. */
export interface StyleProfile {
  /** Number of messages analysed. */
  sampleSize: number
  /** Aggregate metrics across all the user's messages. */
  metrics: StyleMetrics
  /** Recent messages (most recent first), capped to keep the response small. */
  samples: StyleSample[]
  /** Per-chat samples for a specific conversation, if chatId was provided. */
  chatSamples?: StyleSample[]
}

/** Common greeting words in Traditional Chinese and English. */
const GREETING_RE =
  /(?:哈囉|哈嚕|嗨|早安|午安|晚安|你好|您好|hi\b|hello\b|hey\b|good\s*morning|good\s*evening|morning\b)/i

/** Common farewell / gratitude words. */
const FAREWELL_RE =
  /(?:謝謝|多謝|thanks?\b|thank\s*you|掰|再見|bye\b|晚安|see\s*you|later\b)/i

/** Emoji detection: covers common Unicode emoji blocks. */
const EMOJI_RE =
  /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

/** Simple CJK + Latin token extraction for phrase frequency. */
function extractPhrases(text: string): string[] {
  // Extract 2-4 character CJK runs and Latin words (2+ chars).
  const cjkRuns =
    text.match(/[\u{4E00}-\u{9FFF}\u{3400}-\u{4DBF}]{2,4}/gu) ?? []
  const latinWords =
    text.match(/[a-zA-Z]{2,}/gi)?.map((w) => w.toLowerCase()) ?? []
  // Also capture common 1-char CJK sentence-final particles.
  const particles = text.match(/[了啦呢吧啊喔噢嘛]/g) ?? []
  return [...cjkRuns, ...latinWords, ...particles]
}

/**
 * Count phrase frequencies across an array of texts, returning the top-N.
 */
function topPhrases(
  texts: string[],
  topN = 20,
): { phrase: string; count: number }[] {
  const freq = new Map<string, number>()
  for (const text of texts) {
    const phrases = extractPhrases(text)
    // Count each phrase once per message (not per occurrence within a message)
    // to avoid one long message dominating.
    const seen = new Set(phrases)
    for (const p of seen) {
      freq.set(p, (freq.get(p) ?? 0) + 1)
    }
  }
  return [...freq.entries()]
    .map(([phrase, count]) => ({ phrase, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN)
}

/**
 * Determine formality level from message patterns.
 */
function detectFormality(
  texts: string[],
  emojiRatio: number,
  exclamationRatio: number,
): 'casual' | 'neutral' | 'formal' {
  let formalScore = 0
  let casualScore = 0
  for (const t of texts) {
    // Formal markers
    if (/(?:您好|敬請|請見|麻煩|惠請|懇請|敬請|順祝)/.test(t)) formalScore++
    if (/(?:此致|敬上|順頌)/.test(t)) formalScore++
    // Casual markers
    if (EMOJI_RE.test(t)) casualScore += 2
    if (/(?:啦|囉|喔|噢|嘛|耶|欸|嘿)/.test(t)) casualScore++
    if (/(?:哈哈|呵呵|嘿嘿|蛤|XD|xD|www)/i.test(t)) casualScore += 2
    if (/(?:\bOK\b|okay|k\b|嗯|嗯嗯)/i.test(t)) casualScore++
  }
  // Factor in aggregate signals
  if (emojiRatio > 0.3) casualScore += 5
  if (exclamationRatio > 0.2) casualScore += 3

  const avg = texts.length || 1
  if (formalScore / avg > 0.15) return 'formal'
  if (casualScore / avg > 0.3) return 'casual'
  return 'neutral'
}

/**
 * Compute aggregate style metrics from the user's sent messages.
 */
function computeMetrics(texts: string[]): StyleMetrics {
  const total = texts.length
  if (total === 0) {
    return {
      totalMessages: 0,
      avgLength: 0,
      emojiRatio: 0,
      greetingRatio: 0,
      farewellRatio: 0,
      periodEndingRatio: 0,
      exclamationRatio: 0,
      questionRatio: 0,
      commonLengthBucket: 'N/A',
      frequentPhrases: [],
      formality: 'neutral',
    }
  }

  let emojiCount = 0
  let greetingCount = 0
  let farewellCount = 0
  let periodCount = 0
  let exclamationCount = 0
  let questionCount = 0
  let totalLength = 0
  const lengthBuckets = new Map<string, number>()

  for (const text of texts) {
    const len = text.length
    totalLength += len

    // Length bucket (by 10)
    const bucketStart = Math.floor(len / 10) * 10
    const bucketLabel = `${bucketStart}-${bucketStart + 9}`
    lengthBuckets.set(bucketLabel, (lengthBuckets.get(bucketLabel) ?? 0) + 1)

    if (EMOJI_RE.test(text)) emojiCount++
    if (GREETING_RE.test(text)) greetingCount++
    if (FAREWELL_RE.test(text)) farewellCount++

    const trimmed = text.trim()
    if (/[。．.]$/.test(trimmed)) periodCount++
    if (/[！!]$/.test(trimmed)) exclamationCount++
    if (/[？?]$/.test(trimmed)) questionCount++
  }

  // Find most common length bucket
  let maxBucketCount = 0
  let commonBucket = 'N/A'
  for (const [bucket, count] of lengthBuckets) {
    if (count > maxBucketCount) {
      maxBucketCount = count
      commonBucket = bucket
    }
  }

  const emojiRatio = emojiCount / total
  const exclamationRatio = exclamationCount / total

  return {
    totalMessages: total,
    avgLength: Math.round(totalLength / total),
    emojiRatio: Math.round(emojiRatio * 100) / 100,
    greetingRatio: Math.round((greetingCount / total) * 100) / 100,
    farewellRatio: Math.round((farewellCount / total) * 100) / 100,
    periodEndingRatio: Math.round((periodCount / total) * 100) / 100,
    exclamationRatio: Math.round(exclamationRatio * 100) / 100,
    questionRatio: Math.round((questionCount / total) * 100) / 100,
    commonLengthBucket: commonBucket,
    frequentPhrases: topPhrases(texts),
    formality: detectFormality(texts, emojiRatio, exclamationRatio),
  }
}

/**
 * Fetch the user's own sent messages from the search index.
 *
 * @param userMid - The user's LINE MID (from service.profile.mid).
 * @param limit - Maximum number of messages to return (default 200).
 * @param chatId - Optional: restrict to a specific chat.
 * @returns Array of messages the user sent, most recent first.
 */
export function getUserMessages(
  userMid: string,
  limit = 200,
  chatId?: string,
): StyleSample[] {
  const handle = getDb()
  const rows = handle
    .prepare<{
      chatId: string
      chatName: string | null
      text: string
      createdTime: number | null
    }>(
      chatId
        ? `SELECT chatId, chatName, text, createdTime
           FROM messages
           WHERE fromMid = $userMid AND chatId = $chatId AND length(text) > 0
           ORDER BY createdTime DESC NULLS LAST
           LIMIT $limit`
        : `SELECT chatId, chatName, text, createdTime
           FROM messages
           WHERE fromMid = $userMid AND length(text) > 0
           ORDER BY createdTime DESC NULLS LAST
           LIMIT $limit`,
    )
    .all({ $userMid: userMid, $chatId: chatId ?? null, $limit: limit })
  return rows
}

/**
 * Build a complete style profile for the user.
 *
 * @param userMid - The user's LINE MID.
 * @param chatId - Optional: focus on a specific conversation's style.
 * @param sampleSize - Number of recent messages to include as samples (default 50).
 * @returns Style profile with metrics and samples.
 */
export function buildStyleProfile(
  userMid: string,
  chatId?: string,
  sampleSize = 50,
): StyleProfile {
  // Fetch a larger set for metrics, but only include the most recent as samples.
  const allMessages = getUserMessages(userMid, 500, chatId)
  const sampleMessages = allMessages.slice(0, sampleSize)

  const texts = allMessages.map((m) => m.text)
  const metrics = computeMetrics(texts)

  const profile: StyleProfile = {
    sampleSize: allMessages.length,
    metrics,
    samples: sampleMessages,
  }

  // If chatId was specified, also include cross-chat samples for comparison.
  if (chatId) {
    const chatSamples = getUserMessages(userMid, 20, chatId)
    profile.chatSamples = chatSamples
  }

  return profile
}
