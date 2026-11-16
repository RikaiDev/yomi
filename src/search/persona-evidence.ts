/**
 * Persona evidence — the raw material for knowing who someone is.
 *
 * The earlier version of this module tried to work out roles itself, using a
 * list of role words: pharmacist, teacher, supervisor. That list was a
 * liability twice over. It is a guess about which words matter, it needs a
 * human to keep it current, and — worse — it only ever worked in one
 * language, on one machine, for one user. A tool that ships to everyone
 * cannot have a Chinese role dictionary in it, or an English one, or a
 * Japanese one.
 *
 * So this module does something simpler and more honest: it collects the
 * evidence and leaves the naming to whoever reads it.
 *
 * Who reads it
 * ------------
 *
 * Yomi is an MCP server. The tool that returns this evidence is called by an
 * agent — something that can read "Lin pharmacist, good afternoon, could you
 * help me confirm…" and say "this is the hospital pharmacist" without ever
 * having been told that pharmacist is a role word. The agent can then write
 * the name it settled on back with `add_persona_fact`, and the next read
 * shows it.
 *
 * That division of labour holds for every user, in every language, with no
 * model running inside yomi:
 *
 *   - yomi: keeps the evidence fresh, quotable and organised (this module),
 *   - the model: names what the evidence means,
 *   - the store: remembers the names, so they survive.
 *
 * What counts as evidence
 * -----------------------
 *
 *  - **Address forms**: how you open a message to one person, counted. The
 *    form is reported exactly as written — "Lin pharmacist, good afternoon"
 *    yields the form "Lin pharmacist, good afternoon", and the fact that one
 *    form recurs seventeen times while another recurs once is itself the
 *    signal. Nothing here strips greetings or guesses at titles; a reader
 *    that understands the language does that better and without a dictionary.
 *  - **Requests**: the sentences where you hand somebody a piece of work.
 *    Quoted in full, because the work is what identifies the role.
 *  - **Notable lines**: the most informative messages of a conversation,
 *    chosen by length and substance rather than by keyword.
 *
 * Two rules keep this language-neutral:
 *
 *  - A head is an address candidate when it is short, standalone, and
 *    repeats. Repetition is the language-independent test — a form you use
 *    seventeen times is a form; a one-off is a sentence.
 *  - A sentence is a request when it carries an explicit request marker.
 *    Markers are a closed grammatical class, not a role taxonomy, and they
 *    are matched as whole words so the list stays small and extensible.
 *
 * The chat has to be one-to-one for an address form to name anybody: in a
 * group the head of a message addresses the room.
 */

import { getExcludedChatIds } from './scope.js'
import { getDb } from './store.js'

/** The kind of evidence a row carries. */
export type PersonaEvidenceKind = 'address' | 'request' | 'notable'

/** One piece of evidence about a person. */
export interface PersonaEvidence {
  /** The person's LINE MID. */
  mid: string
  /** The person's display name, when the index has one. */
  name: string | null
  /** What kind of evidence this is. */
  kind: PersonaEvidenceKind
  /**
   * The address form, for address evidence — the way you open a message to
   * this person, reported verbatim. Counted, because repetition is what
   * makes a form a form.
   */
  form: string | null
  /** The evidence itself, quoted. */
  text: string
  /** How many times this form was used, for address evidence. */
  occurrences: number
  /** Where the evidence lives. */
  source: { chatId: string; chatName: string | null }
}

/** A row as stored in the `messages` table. */
export interface EvidenceRow {
  chatId: string
  chatName: string | null
  fromMid: string | null
  fromName: string | null
  text: string
  createdTime: number | null
}

/** Characters that end the head of a message across common scripts. */
const ADDRESS_BREAKS = /[。，！？!、：:;？?,\n]/

/**
 * Request markers: the closed grammatical class that turns a sentence into a
 * request.
 *
 * These say "you are being asked to do something". They say nothing about
 * what the work is, so they are a grammar aid rather than a role taxonomy —
 * which is what keeps the module free of any role dictionary.
 */
const REQUEST_MARKERS = [
  // Chinese
  '麻煩',
  '請您',
  '請你',
  '請幫',
  '請',
  '幫我',
  '幫忙',
  '協助',
  '再請',
  '好請',
  '有空的時候',
  '麻煩您',
  '麻煩你',
  // English
  'please',
  'could you',
  'can you',
  'would you',
  'help me',
  'help you',
  'need you to',
  'remind',
  'follow up',
]

/**
 * Whether a sentence asks somebody to do something.
 *
 * @param text - The sentence.
 * @returns True when the sentence reads as a request.
 */
function isRequest(text: string): boolean {
  const body = text.replace(/\n/g, '').toLowerCase()
  return REQUEST_MARKERS.some((marker) => body.includes(marker.toLowerCase()))
}

/**
 * Split a message into sentence-ish units.
 *
 * Hard sentence breaks split. Clause separators are kept whole, because a
 * request and the work it names usually sit in the same clause.
 *
 * @param text - The message text.
 * @returns The sentences.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/[。！？!?\n；;]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * Collapse evidence to a single quotable line.
 *
 * @param text - The evidence text.
 * @returns The first non-empty line, trimmed.
 */
function oneLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return text.trim()
}

/**
 * The head of a message, before the first clause or sentence break.
 *
 * The head is kept whole. Whether it addresses somebody, and whether it
 * names a role, is not decided here — repetition decides whether it is a
 * form at all, and the reader decides what it means.
 *
 * @param text - The message text.
 * @returns The head, or null when there is none.
 */
export function addressFormOf(text: string): string | null {
  const head = text.trim().split(ADDRESS_BREAKS)[0]?.trim() ?? ''
  if (!head || head.length > 12) {
    return null
  }
  // A head that carries a copula is a sentence, not an address.
  if (/[是的為]/.test(head)) {
    return null
  }
  return head
}

/**
 * How informative a message is, for choosing the notable lines.
 *
 * Longer is not automatically better, but a message with no words in it is
 * not evidence of anything. The score rewards substance and punishes the
 * sticker-and-payload traffic that would otherwise dominate a chat.
 *
 * @param text - The message text.
 * @returns A non-negative score.
 */
function informativeness(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return 0
  }
  if (/^[[{]/.test(trimmed)) {
    // Attachments and key material carry no meaning on their own.
    return 0
  }
  if (/^\[(スタンプ|貼圖|Sticker|image|photo)\]$/i.test(trimmed)) {
    return 0
  }
  // A line that opens with an emoji is a banner or a sticker caption, not
  // something anybody would read as evidence of a relationship.
  if (/^\p{Extended_Pictographic}/u.test(trimmed)) {
    return 0
  }
  const cjk = (trimmed.match(/[一-鿿]/g) ?? []).length
  const words = trimmed.split(/\s+/).filter((w) => w.length > 1).length
  const score = cjk + words * 2
  // A line that is mostly a payload or a URL carries no meaning.
  if (/^(https?:|\{)/.test(trimmed) && score < 4) {
    return 0
  }
  return score
}

/**
 * Collect the evidence about everyone in the indexed conversations.
 *
 * @param rows - Message rows, any order.
 * @param selfMid - The account owner's MID.
 * @returns The evidence.
 */
export function collectEvidence(
  rows: EvidenceRow[],
  selfMid: string,
): PersonaEvidence[] {
  const names = new Map<string, string | null>()
  for (const row of rows) {
    if (!row.fromMid || row.fromMid === selfMid) {
      continue
    }
    if (row.fromName) {
      names.set(row.fromMid, row.fromName)
    }
  }

  // Chat membership, so one-to-one chats can be told from groups.
  const chatMembers = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!row.fromMid) {
      continue
    }
    const members = chatMembers.get(row.chatId)
    if (members) {
      members.add(row.fromMid)
    } else {
      chatMembers.set(row.chatId, new Set([row.fromMid]))
    }
  }
  const chatPeer = new Map<string, string>()
  for (const [chatId, members] of chatMembers) {
    if (members.size !== 2) {
      continue
    }
    for (const mid of members) {
      if (mid !== selfMid) {
        chatPeer.set(chatId, mid)
        break
      }
    }
  }

  // Address forms, counted. Repetition is what makes a head a form.
  const forms = new Map<
    string,
    Map<
      string,
      {
        form: string
        count: number
        evidence: string
        source: { chatId: string; chatName: string | null }
      }
    >
  >()
  // Requests, quoted.
  const requests = new Map<
    string,
    Map<
      string,
      { text: string; source: { chatId: string; chatName: string | null } }
    >
  >()

  for (const row of rows) {
    if (row.fromMid !== selfMid) {
      continue
    }
    const peer = chatPeer.get(row.chatId)
    if (!peer) {
      continue
    }

    const form = addressFormOf(row.text)
    if (form) {
      const byForm = forms.get(peer) ?? new Map()
      const hit = byForm.get(form)
      if (hit) {
        hit.count += 1
      } else {
        byForm.set(form, {
          form,
          count: 1,
          evidence: oneLine(row.text),
          source: { chatId: row.chatId, chatName: row.chatName },
        })
      }
      forms.set(peer, byForm)
    }

    for (const sentence of splitSentences(row.text)) {
      if (!isRequest(sentence)) {
        continue
      }
      const quoted = oneLine(sentence)
      if (quoted.length < 6) {
        continue
      }
      // Attachments and key material are not requests, however they were
      // phrased.
      if (/^\{/.test(quoted) || /^https?:/.test(quoted)) {
        continue
      }
      const byText = requests.get(peer) ?? new Map()
      if (!byText.has(quoted)) {
        byText.set(quoted, {
          text: quoted,
          source: { chatId: row.chatId, chatName: row.chatName },
        })
      }
      requests.set(peer, byText)
    }
  }

  // Notable lines: the most informative message of each conversation, from
  // either side.
  const notable = new Map<
    string,
    {
      text: string
      score: number
      source: { chatId: string; chatName: string | null }
    }
  >()
  for (const row of rows) {
    if (!row.fromMid) {
      continue
    }
    const peers = [...(chatMembers.get(row.chatId) ?? [])].filter(
      (mid) => mid !== selfMid,
    )
    const score = informativeness(row.text)
    if (score === 0) {
      continue
    }
    for (const peer of peers) {
      const hit = notable.get(peer)
      if (!hit || score > hit.score) {
        notable.set(peer, {
          text: oneLine(row.text),
          score,
          source: { chatId: row.chatId, chatName: row.chatName },
        })
      }
    }
  }

  const evidence: PersonaEvidence[] = []
  for (const [mid, byForm] of forms) {
    for (const hit of byForm.values()) {
      evidence.push({
        mid,
        name: names.get(mid) ?? null,
        kind: 'address',
        form: hit.form,
        text: hit.evidence,
        occurrences: hit.count,
        source: hit.source,
      })
    }
  }
  for (const [mid, byText] of requests) {
    for (const hit of byText.values()) {
      evidence.push({
        mid,
        name: names.get(mid) ?? null,
        kind: 'request',
        form: null,
        text: hit.text,
        occurrences: 1,
        source: hit.source,
      })
    }
  }
  for (const [mid, hit] of notable) {
    evidence.push({
      mid,
      name: names.get(mid) ?? null,
      kind: 'notable',
      form: null,
      text: hit.text,
      occurrences: 1,
      source: hit.source,
    })
  }

  return evidence
}

/**
 * Read the indexed messages the evidence is collected from.
 *
 * Excluded conversations are skipped here, not afterwards: an excluded chat
 * contributes nothing, not even a name.
 *
 * @param limit - Maximum number of rows to read.
 * @param chatIds - When given, only these chats are read.
 * @returns The rows and the number of excluded chats that were skipped.
 */
export function loadEvidenceRows(
  limit: number,
  chatIds?: string[],
): { rows: EvidenceRow[]; excluded: number } {
  const handle = getDb()
  const excludedIds = getExcludedChatIds()
  const rows = chatIds?.length
    ? (handle
        .prepare<EvidenceRow>(
          `SELECT chatId, chatName, fromMid, fromName, text, createdTime
           FROM messages
           WHERE chatId IN (${chatIds.map((_, i) => `$c${i}`).join(',')})
           ORDER BY createdTime DESC NULLS LAST;`,
        )
        .all(
          Object.fromEntries(chatIds.map((id, i) => [`$c${i}`, id])),
        ) as EvidenceRow[])
    : (handle
        .prepare<EvidenceRow>(
          `SELECT chatId, chatName, fromMid, fromName, text, createdTime
           FROM messages
           ORDER BY createdTime DESC NULLS LAST
           LIMIT $limit;`,
        )
        .all({ $limit: limit }) as EvidenceRow[])
  const kept = rows.filter((row) => !excludedIds.has(row.chatId))
  const excludedCount = new Set(
    rows.filter((row) => excludedIds.has(row.chatId)).map((row) => row.chatId),
  ).size
  return { rows: kept, excluded: excludedCount }
}
