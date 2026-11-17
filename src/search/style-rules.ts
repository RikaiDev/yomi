/**
 * Style evidence and per-chat vocabulary.
 *
 * Two things the style profile cannot produce on its own:
 *
 * 1. **Evidence.** The profile's statistics describe a corpus; a rule needs
 *    the sentences themselves. `getStyleEvidence` hands over the owner's own
 *    messages, quoted, with the situation each one answered — so a model
 *    reading them can write a rule that says when it applies, not just what
 *    it is.
 *
 * 2. **What the counterpart already knows.** A message can be perfectly
 *    written and still confuse the person receiving it, because it names
 *    something they have never heard of. `getChatVocabulary` splits the terms
 *    of a conversation into the ones the other side has used themselves
 *    (`knownTerms`) and the ones only the owner has used (`unconfirmedTerms`).
 *
 * Both are measurements: n-gram intersection is a guess about what a term
 * means. The judgement — "do not name our company to the vendor" — is the
 * model's to write, and it belongs in a style rule, not here.
 */
import { getDb } from './store.js'

/** One of the owner's own messages, quoted verbatim, with its situation. */
export interface StyleEvidenceQuote {
  chatId: string
  chatName: string | null
  createdTime: number | null
  /** The owner's message, verbatim. */
  text: string
  /** The counterpart's preceding message, truncated, when there was one. */
  situation: string | null
  /** The other side's display name in this conversation. */
  counterpartName: string | null
}

/** A conversation's shared vocabulary, split by who used each term. */
export interface ChatVocabulary {
  chatId: string
  chatName: string | null
  counterpartName: string | null
  /** Terms the counterpart has used in this conversation themselves. */
  knownTerms: { term: string; ownerUses: number; theyUse: number }[]
  /** Terms only the owner has used — the counterpart has not seen them here. */
  unconfirmedTerms: { term: string; ownerUses: number }[]
}

interface ChatMessageRow {
  chatId: string
  chatName: string | null
  fromMid: string | null
  fromName: string | null
  text: string | null
  createdTime: number | null
  contentType: number | null
}

/**
 * Common Chinese function words. A gram made only of these is grammar, not
 * vocabulary: a gram made only of grammar tells a reader nothing.
 */
const STOP_GRAMS = new Set([
  '好的',
  '收到',
  '謝謝',
  '感謝',
  '抱歉',
  '麻煩',
  '感恩',
  '不好意思',
  '可以',
  '沒有',
  '有了',
  '這個',
  '那個',
  '我們',
  '你們',
  '大家',
  '什麼',
  '怎麼',
  '為什麼',
  '一下',
  '一起',
  '現在',
  '已經',
  '還是',
  '應該',
  '需要',
  '問題',
  '部分',
  '相關',
  '目前',
  '今天',
  '明天',
  '昨天',
  '上次',
  '下次',
  '先',
  '後',
  '再',
  '就',
  '也',
  '都',
  '很',
  '太',
  '比較',
  '有點',
  '不過',
  '但是',
  '所以',
  '因為',
  '如果',
  '可是',
  '而且',
  '或是',
  '或者',
  '除了',
  '關於',
  '對於',
  '至於',
  '由於',
  '，以及',
  '的話',
  '這樣',
  '那樣',
  '這裡',
  '那裡',
  '以上',
  '以下',
])

/** Characters that appear in almost every Chinese sentence. */
const STOP_CHARS = new Set(
  '的了是我你您們好那這個不就要會被把跟給讓對從到還再又只更最也都很沒在有和與或而之其以為此其等',
)

const CJK_RUN = /[一-鿿]+/g

/**
 * Every CJK n-gram of a message, from `min` to `max` characters.
 *
 * @param text - The message text.
 * @param min - Shortest gram length.
 * @param max - Longest gram length.
 * @returns The grams, with repeats, so callers can count them.
 */
function cjkGrams(text: string, min: number, max: number): string[] {
  const out: string[] = []
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let n = min; n <= max; n++) {
      for (let i = 0; i + n <= run.length; i++) out.push(run.slice(i, i + n))
    }
  }
  return out
}

/** A gram is real vocabulary when it is not grammar and carries content. */
function isContentGram(gram: string): boolean {
  if (gram.length < 2) return false
  if (STOP_GRAMS.has(gram)) return false
  if ([...gram].every((c) => STOP_CHARS.has(c))) return false
  return true
}

/**
 * Characters a term often ends with without them being part of the term.
 *
 * A name followed by a particle produces a longer gram that ends in the
 * particle; the particle belongs to the sentence, not to the name.
 */
const TAIL_CHARS = new Set(
  '的了在是我你您們和與或呢嗎啊吧就都也很更還要會把被給讓對從到再又只個',
)

/**
 * Strip trailing particles from a gram, keeping at least two characters.
 *
 * @param gram - The candidate term.
 * @returns The term without its trailing particles.
 */
function stripTail(gram: string): string {
  let out = gram
  while (out.length > 2 && TAIL_CHARS.has(out[out.length - 1])) {
    out = out.slice(0, -1)
  }
  return out
}

/**
 * Keep the longest terms and drop the ones contained in them.
 *
 * A longer name and the shorter fragment inside it are both counted; only the
 * longer one is worth showing, because a reader told the fragment has learned
 * less. Grams that differ only by a trailing particle are the same term and
 * are merged.
 *
 * @param grams - Candidate grams with their counts.
 * @returns The kept grams, most used first.
 */
function maximalGrams(
  grams: Map<string, { owner: number; they: number }>,
): { term: string; owner: number; they: number }[] {
  const byTerm = new Map<
    string,
    { term: string; owner: number; they: number }
  >()
  for (const [raw, counts] of grams) {
    const term = stripTail(raw)
    const existing = byTerm.get(term)
    if (existing) {
      existing.owner += counts.owner
      existing.they += counts.they
      continue
    }
    byTerm.set(term, { term, owner: counts.owner, they: counts.they })
  }
  const sorted = [...byTerm.values()].sort((a, b) => {
    const diff = b.owner + b.they - (a.owner + a.they)
    return diff !== 0 ? diff : b.term.length - a.term.length
  })
  const kept: { term: string; owner: number; they: number }[] = []
  for (const entry of sorted) {
    if (kept.some((k) => k.term.includes(entry.term))) continue
    kept.push(entry)
  }
  return kept
}

function chatRows(chatId: string, limit = 300): ChatMessageRow[] {
  return getDb()
    .prepare<ChatMessageRow>(
      `SELECT chatId, chatName, fromMid, fromName, text, createdTime, contentType
       FROM messages
       WHERE chatId = $chatId
       ORDER BY createdTime ASC NULLS LAST
       LIMIT $limit;`,
    )
    .all({ $chatId: chatId, $limit: limit })
}

/**
 * The owner's own messages in a conversation, quoted, each with the message
 * it answered.
 *
 * @param userMid - The owner's LINE MID.
 * @param chatId - The conversation to read, or undefined for every chat.
 * @param limit - How many quotes to return at most.
 * @returns The quotes, newest first.
 */
export function getStyleEvidence(
  userMid: string,
  chatId?: string,
  limit = 60,
): StyleEvidenceQuote[] {
  const handle = getDb()
  const rows = chatId
    ? handle
        .prepare<ChatMessageRow>(
          `SELECT chatId, chatName, fromMid, fromName, text, createdTime, contentType
           FROM messages
           WHERE chatId = $chatId
           ORDER BY createdTime ASC NULLS LAST
           LIMIT 400;`,
        )
        .all({ $chatId: chatId })
    : handle
        .prepare<ChatMessageRow>(
          `SELECT chatId, chatName, fromMid, fromName, text, createdTime, contentType
           FROM messages
           ORDER BY createdTime DESC NULLS LAST
           LIMIT $limit;`,
        )
        .all({ $limit: limit })
  const quotes: StyleEvidenceQuote[] = []
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    if (row.fromMid !== userMid) continue
    if (!row.text) continue
    if (row.contentType === 7) continue
    const previous = rows[i - 1]
    const situation =
      previous && previous.fromMid !== userMid && previous.text
        ? previous.text.length > 160
          ? `${previous.text.slice(0, 160)}…`
          : previous.text
        : null
    const counterpart = rows.find((r) => r.fromMid !== userMid)
    quotes.push({
      chatId: row.chatId,
      chatName: row.chatName,
      createdTime: row.createdTime,
      text: row.text,
      situation,
      counterpartName: counterpart?.fromName ?? null,
    })
  }
  return quotes.reverse().slice(0, limit)
}

/**
 * Split a conversation's terms by who used them.
 *
 * A term both sides used is something the counterpart has already said
 * themselves. A term only the owner used is something they have never heard
 * of — the list of things that can confuse someone.
 *
 * @param ownerTexts - The owner's messages.
 * @param theirTexts - The counterpart's messages.
 * @returns The shared terms and the owner-only terms.
 */
export function extractVocabulary(
  ownerTexts: string[],
  theirTexts: string[],
): {
  knownTerms: { term: string; ownerUses: number; theyUse: number }[]
  unconfirmedTerms: { term: string; ownerUses: number }[]
} {
  const ownerCounts = new Map<string, number>()
  const theyCounts = new Map<string, number>()
  for (const [texts, target] of [
    [ownerTexts, ownerCounts],
    [theirTexts, theyCounts],
  ] as const) {
    for (const text of texts) {
      for (const gram of cjkGrams(text, 2, 5)) {
        if (!isContentGram(gram)) continue
        target.set(gram, (target.get(gram) ?? 0) + 1)
      }
    }
  }
  const merged = new Map<string, { owner: number; they: number }>()
  for (const [gram, count] of ownerCounts) {
    merged.set(gram, { owner: count, they: theyCounts.get(gram) ?? 0 })
  }
  for (const [gram, count] of theyCounts) {
    const entry = merged.get(gram)
    if (entry) entry.they = count
    else merged.set(gram, { owner: 0, they: count })
  }
  const maximal = maximalGrams(merged)
  return {
    knownTerms: maximal
      .filter((t) => t.they > 0 && t.owner > 0)
      .slice(0, 25)
      .map((t) => ({ term: t.term, ownerUses: t.owner, theyUse: t.they })),
    unconfirmedTerms: maximal
      .filter((t) => t.they === 0 && t.owner >= 2)
      .slice(0, 15)
      .map((t) => ({ term: t.term, ownerUses: t.owner })),
  }
}

/**
 * The vocabulary of a conversation, split by who used each term.
 *
 * @param userMid - The owner's LINE MID.
 * @param chatId - The conversation to read, or undefined for every chat.
 * @returns One entry per conversation with its known and unconfirmed terms.
 */
export function getChatVocabulary(
  userMid: string,
  chatId?: string,
): ChatVocabulary[] {
  const handle = getDb()
  const chatIds = chatId
    ? [chatId]
    : handle
        .prepare<{ chatId: string }>(
          `SELECT DISTINCT chatId FROM messages
           WHERE fromMid = $userMid OR chatId IN (SELECT chatId FROM messages WHERE fromMid = $userMid)
           LIMIT 40;`,
        )
        .all({ $userMid: userMid })
        .map((r) => r.chatId)
  const out: ChatVocabulary[] = []
  for (const id of chatIds) {
    const rows = chatRows(id)
    const ownerTexts: string[] = []
    const theirTexts: string[] = []
    let chatName: string | null = null
    let counterpartName: string | null = null
    for (const row of rows) {
      if (!row.text || row.contentType === 7) continue
      if (chatName === null) chatName = row.chatName
      const mine = row.fromMid === userMid
      if (!mine && counterpartName === null) counterpartName = row.fromName
      ;(mine ? ownerTexts : theirTexts).push(row.text)
    }
    const vocabulary = extractVocabulary(ownerTexts, theirTexts)
    out.push({
      chatId: id,
      chatName,
      counterpartName,
      knownTerms: vocabulary.knownTerms,
      unconfirmedTerms: vocabulary.unconfirmedTerms,
    })
  }
  return out
}
