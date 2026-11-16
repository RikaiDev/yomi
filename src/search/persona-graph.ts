/**
 * Persona graph — who the people in your conversations are.
 *
 * The style profile (./style-profile.ts) answers "how do I write". This module
 * answers the other half: "who am I talking to, and how do they write". An
 * assistant drafting a reply needs both, and needs them as claims that can be
 * checked — the same discipline the style profile follows: every statement
 * carries either a rate or the verbatim line it came from.
 *
 * What it produces
 * ----------------
 *  - one node per person other than you (keyed by their LINE MID),
 *  - the roles you have stated for them ("my wife", "the hospital pharmacist"),
 *    each with the sentence that stated it,
 *  - how you address them ("Lin pharmacist", "Yijun"),
 *  - how you behave with them (reciprocity, reply rhythm, volume),
 *  - how THEY write (the same structural analysis the style profile runs on
 *    your own messages, run on theirs),
 *  - the people who share a conversation with you, as edges.
 *
 * What it refuses to do
 * ---------------------
 *  - It never guesses. A role appears only when your own message names the
 *    person and a role word in the same sentence, and the sentence is kept as
 *    the evidence. A person with no such sentence simply has no roles.
 *  - It never invents a relationship between two people. The only edges are
 *    shared conversations and the roles you stated.
 *  - It reads the local index only. No network, no LINE session required. The
 *    excluded-chat denylist (./scope.ts) is honoured, so an excluded
 *    conversation contributes nothing — not even a name.
 *
 * This is derived from the same local index that holds your messages in
 * plaintext, so it inherits that artifact's sensitivity: keep it local, and
 * treat the roles it reports as private facts about third parties.
 */

import { analyzeNarrative, type NarrativeProfile } from './narrative.js'
import { collectEvidence, type EvidenceRow } from './persona-evidence.js'
import { deriveAllEvidence, getPersistedEvidence } from './persona-index.js'
import { getExcludedChatIds } from './scope.js'
import {
  getDb,
  listPersonaFacts,
  type PersonaEvidenceRecord,
  type PersonaNodeRecord,
} from './store.js'

/**
 * Coarse grouping of a role, chosen by whoever named the role.
 *
 * Yomi keeps the grouping free-form on purpose: the categories are a
 * convenience for the reader, not a taxonomy the tool imposes.
 */
export type PersonaRoleCategory =
  | 'family'
  | 'household'
  | 'workplace'
  | 'professional'
  | 'client'
  | 'other'

/**
 * A role for someone, with the evidence that supports it.
 *
 * Yomi never decides a role on its own. A role exists here because a model
 * reading the evidence named it and wrote it back with the sentence it based
 * the name on — so the evidence is always the user's own words.
 */
export interface PersonaRole {
  /** The role term, e.g. "wife" or "pharmacist". */
  term: string
  /** The role category the term belongs to. */
  category: PersonaRoleCategory
  /** The sentence, verbatim, that the name was based on. */
  evidence: string
  /** Where the evidence lives. */
  source: { chatId: string; chatName: string | null }
  /**
   * Where the role came from: a fact a model named from the evidence
   * (`named`), or a fact the owner stated outright (`stated`).
   */
  origin: 'named' | 'stated'
  /** How many independent instances back it. */
  instances: number
  /** Confidence in [0,1], as the namer assessed it. */
  confidence: number
}

/**
 * One piece of quotable evidence about a person.
 *
 * This is what yomi can say on its own: the address form used with them,
 * the work delegated to them, and their most substantial line — each quoted
 * from the conversation. What it means is left to the reader.
 */
export interface PersonaEvidenceLine {
  /** What kind of evidence this is. */
  kind: 'address' | 'request' | 'notable'
  /** The address form, when the evidence is one. */
  form: string | null
  /** The evidence, quoted. */
  text: string
  /** How many times the form was used. */
  occurrences: number
  /** Where the evidence lives. */
  source: { chatId: string; chatName: string | null }
}

/** How you address one person, with the message that shows it. */
export interface PersonaAddress {
  /** The address form you use, e.g. "Lin pharmacist". */
  form: string
  /** Your own message, verbatim, that used it. */
  evidence: string
  source: { chatId: string; chatName: string | null }
}

/** How you behave in one conversation with one person. */
export interface PersonaConversation {
  chatId: string
  chatName: string | null
  /** Messages they sent in this chat. */
  theirMessages: number
  /** Messages you sent in this chat. */
  yourMessages: number
  /** Their share of the two-way exchange, in [0,1]. */
  reciprocity: number
  /** Median hand-off latency from them to you, in hours. */
  rhythmHours: number | null
}

/** A condensed read of how one other person writes. */
export interface PersonaVoice {
  /** Messages of theirs analyzed. */
  sampleSize: number
  avgChars: number
  medianChars: number
  /** The honorific they use most, when any. */
  dominantHonorific: string | null
  /** The speech act they perform most, with its share. */
  topAct: { label: string; rate: number } | null
  /** The politeness position their requests sit at, with its share. */
  requestStrategy: { label: string; rate: number } | null
  /** The discourse unit kind they use most, with its share. */
  topUnitKind: { label: string; rate: number } | null
  /** Whether the sample was rich enough to describe. */
  sufficient: boolean
}

/** One person in your conversations. */
export interface PersonaNode {
  mid: string
  name: string | null
  /**
   * Roles for this person, each with the evidence it rests on. Yomi does not
   * decide these; they are what a model named from the evidence and wrote
   * back.
   */
  roles: PersonaRole[]
  /**
   * The quotable evidence about this person: the address form used with
   * them, the work delegated to them, their most substantial line.
   */
  evidence: PersonaEvidenceLine[]
  /** Address forms you use for this person. */
  addresses: PersonaAddress[]
  /** Your conversations with this person. */
  conversations: PersonaConversation[]
  /** How this person writes. */
  voice: PersonaVoice | null
}

/** Two people who appear in the same conversation as you. */
export interface PersonaEdge {
  /** One person's MID. */
  a: string
  /** The other person's MID. */
  b: string
  /** Conversations you share with both. */
  chatIds: string[]
}

/** The whole graph. */
export interface PersonaGraph {
  /** The account owner's MID. */
  selfMid: string
  /** People other than you. */
  people: PersonaNode[]
  /** People who show up in the same conversations. */
  edges: PersonaEdge[]
  /** Compact natural-language briefing, one line per claim. */
  guide: string[]
  /** What this graph is and is not. */
  method: {
    heuristic: true
    /** Messages read from the index. */
    sampleSize: number
    /** Conversations read from the index. */
    conversationCount: number
    /** Conversations skipped by the exclusion denylist. */
    excludedConversations: number
    /** Total shared-conversation edges before the display cap. */
    edgeCount: number
    /** Edges actually included in the output. */
    edgesShown: number
    /** Roles named for people, from facts written back by a reader. */
    namedRoles: number
    /** Pieces of quotable evidence collected about the people. */
    evidenceCount: number
  }
}

/** A row as stored in the `messages` table. */
export interface PersonaRow {
  chatId: string
  chatName: string | null
  fromMid: string | null
  fromName: string | null
  text: string
  createdTime: number | null
}

/**
 * A role the account owner stated outside the indexed conversations.
 *
 * The LINE index only contains what was written to people in LINE. When the
 * owner tells a role to an assistant ("Yijun is my wife and our finance
 * person"), that sentence exists nowhere in the index — so it is stored
 * separately and merged into the graph here, with the owner's own wording as
 * the evidence, on the same footing as a role read from a message.
 */
export interface PersonaFact {
  /** The person's LINE MID, when known. */
  subjectMid: string | null
  /** The person's name, as the owner wrote it. */
  subjectName: string
  /** The role word, e.g. "wife" or "finance". */
  term: string
  /** The role category the term belongs to. */
  category: string
  /** The owner's own sentence, verbatim. */
  evidence: string
  /**
   * Whether the owner stated this outright, or a model named it from the
   * evidence.
   */
  origin: 'named' | 'stated'
  /** How many independent instances back it. */
  instances: number
  /** Confidence in [0,1], as the namer assessed it. */
  confidence: number
}

/**
 * Greetings that can close an address form (a name followed by a greeting). */
const GREETINGS = [
  '你好',
  '您好',
  '嗨',
  '哈囉',
  '哈罗',
  '早安',
  '午安',
  '晚安',
  '你好呀',
]

/**
 * Coerce a stored category string into a known category.
 *
 * The categories are a convenience for the reader, so an unknown value falls
 * back to `other` rather than widening the type at runtime.
 *
 * @param category - The stored category.
 * @returns A known category.
 */
function normalizeRoleCategory(category: string): PersonaRoleCategory {
  const known: PersonaRoleCategory[] = [
    'family',
    'household',
    'workplace',
    'professional',
    'client',
    'other',
  ]
  return known.includes(category as PersonaRoleCategory)
    ? (category as PersonaRoleCategory)
    : 'other'
}

/** Characters that end the head of a message. */
const ADDRESS_BREAKS = /[。，！？!、：:;\n]/

/**
 * The address form at the head of a message: a name followed by a greeting,
 * or a name followed by a title. A head that carries a copula or a
 * possessive is a sentence, not an address, so it is rejected.
 *
 * @param text - The message text.
 * @returns The address form, or null when the head is not an address.
 */
function addressFormOf(text: string): string | null {
  const head = text.trim().split(ADDRESS_BREAKS)[0]?.trim() ?? ''
  if (!head || head.length > 10) {
    return null
  }
  for (const greeting of GREETINGS) {
    if (head.endsWith(greeting)) {
      const form = head.slice(0, -greeting.length).trim()
      return form.length >= 1 && form.length <= 6 ? form : null
    }
  }
  return null
}

/**
 * Collapse a piece of evidence to a single line.
 *
 * Evidence is meant to be a quotable sentence. A LINE message can carry
 * newlines, and a whole message quoted back is noise in a briefing — so the
 * evidence keeps its first line, trimmed.
 *
 * @param text - The text to collapse.
 * @returns The first non-empty line of the text.
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
 * Median of a list of numbers, or 0 for an empty list.
 *
 * @param values - Numbers to summarize.
 * @returns The median value.
 */
function median(values: number[]): number {
  if (values.length === 0) {
    return 0
  }
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Median turn hand-off latency in hours from the other side to you.
 *
 * @param messages - Messages with a sender and a timestamp.
 * @param selfMid - The account owner's MID.
 * @returns Median latency in hours, or null when there is no hand-off.
 */
function replyRhythmHours(
  messages: { fromMid: string | null; createdTime: number }[],
  selfMid: string,
): number | null {
  const timed = messages
    .filter((m) => m.createdTime != null)
    .sort((a, b) => (a.createdTime ?? 0) - (b.createdTime ?? 0))
  const turns: { self: boolean; last: number }[] = []
  for (const message of timed) {
    const self = message.fromMid === selfMid
    const top = turns[turns.length - 1]
    if (!top || top.self !== self) {
      turns.push({ self, last: message.createdTime ?? 0 })
    } else {
      top.last = message.createdTime ?? 0
    }
  }
  const latencies: number[] = []
  for (let i = 1; i < turns.length; i++) {
    if (turns[i].self && !turns[i - 1].self) {
      latencies.push((turns[i].last - turns[i - 1].last) / 3_600_000)
    }
  }
  if (latencies.length === 0) {
    return null
  }
  latencies.sort((a, b) => a - b)
  return latencies[Math.floor(latencies.length / 2)]
}

/**
 * Read indexed messages, newest first, skipping excluded conversations.
 *
 * @param limit - Maximum number of rows to read.
 * @returns Rows and the number of excluded conversations that were skipped.
 */
function loadRows(limit: number): { rows: PersonaRow[]; excluded: number } {
  const handle = getDb()
  const excludedIds = getExcludedChatIds()
  const rows = handle
    .prepare<PersonaRow>(
      `SELECT chatId, chatName, fromMid, fromName, text, createdTime
       FROM messages
       ORDER BY createdTime DESC NULLS LAST
       LIMIT $limit;`,
    )
    .all({ $limit: limit })
  const kept = rows.filter((row) => !excludedIds.has(row.chatId))
  const excludedCount = new Set(
    rows.filter((row) => excludedIds.has(row.chatId)).map((row) => row.chatId),
  ).size
  return { rows: kept, excluded: excludedCount }
}

/**
 * Condense a narrative profile into the handful of numbers a persona card
 * needs.
 *
 * @param profile - The structural profile of one talker.
 * @param texts - That talker's messages, for the length statistics.
 * @returns The condensed voice read.
 */
function condenseVoice(
  profile: NarrativeProfile,
  texts: string[],
): PersonaVoice {
  const topAct = [...profile.actRates].sort((a, b) => b.rate - a.rate)[0]
  const topStrategy = [...profile.strategyRates].sort(
    (a, b) => b.rate - a.rate,
  )[0]
  const topUnit = [...profile.unitRates].sort((a, b) => b.rate - a.rate)[0]
  const lengths = texts.map((text) => text.length)
  return {
    sampleSize: profile.sampleSize,
    avgChars: lengths.length
      ? Math.round(lengths.reduce((sum, n) => sum + n, 0) / lengths.length)
      : 0,
    medianChars: median(lengths),
    dominantHonorific: profile.honorifics.dominant,
    topAct: topAct ? { label: topAct.label, rate: topAct.rate } : null,
    requestStrategy: topStrategy
      ? { label: topStrategy.label, rate: topStrategy.rate }
      : null,
    topUnitKind: topUnit ? { label: topUnit.label, rate: topUnit.rate } : null,
    sufficient: profile.sufficient,
  }
}

/**
 * Build the persona graph from the local index.
 *
 * @param selfMid - The account owner's LINE MID.
 * @param options - `limit` caps how many indexed messages are read.
 * @returns The persona graph for the people in the indexed conversations.
 */
export function getPersonaGraph(
  selfMid: string,
  options: { limit?: number; maxEdges?: number; derive?: boolean } = {},
): PersonaGraph {
  const limit = options.limit ?? 20_000
  const { rows, excluded } = loadRows(limit)
  const graph = buildPersonaGraph(
    rows,
    selfMid,
    listPersonaFacts() as PersonaFact[],
  )
  const maxEdges = options.maxEdges ?? 200
  const edges = graph.edges.slice(0, maxEdges)
  return {
    ...graph,
    edges,
    method: {
      ...graph.method,
      excludedConversations: excluded,
      edgeCount: graph.edges.length,
      edgesShown: edges.length,
      namedRoles: graph.method.namedRoles,
      evidenceCount: graph.method.evidenceCount,
    },
  }
}

/**
 * Read the persisted persona evidence.
 *
 * The evidence collection runs in the background (see ./persona-index.ts),
 * so this is the cheap path: it reads what the last pass collected instead
 * of rescanning the corpus. When nothing has been collected yet, it collects
 * once so a caller never sees an empty graph on a fresh install.
 *
 * @param selfMid - The account owner's LINE MID.
 * @returns The persisted evidence, the personas, and when the pass ran.
 */
export function getPersistedPersona(selfMid: string): {
  evidence: PersonaEvidenceRecord[]
  nodes: PersonaNodeRecord[]
  state: { derivedAt: number | null; messageCount: number; roleCount: number }
} {
  const persisted = getPersistedEvidence()
  if (persisted.state.roleCount === 0) {
    deriveAllEvidence(selfMid)
    return getPersistedEvidence()
  }
  return persisted
}

/**
 * Build the persona graph from message rows.
 *
 * This is the pure core: it takes rows and returns the graph, so the rules can
 * be tested without a database.
 *
 * @param rows - Message rows, any order.
 * @param selfMid - The account owner's LINE MID.
 * @returns The persona graph for the people in those conversations.
 */
export function buildPersonaGraph(
  rows: PersonaRow[],
  selfMid: string,
  facts: PersonaFact[] = [],
): PersonaGraph {
  // People, by MID. `name` is the most recent display name seen for them.
  const people = new Map<string, { name: string | null; texts: string[] }>()
  for (const row of rows) {
    if (!row.fromMid || row.fromMid === selfMid) {
      continue
    }
    let person = people.get(row.fromMid)
    if (!person) {
      person = { name: null, texts: [] }
      people.set(row.fromMid, person)
    }
    if (row.fromName) {
      person.name = row.fromName
    }
    if (row.text.trim()) {
      person.texts.push(row.text)
    }
  }

  // Conversations, grouped by chat.
  const chats = new Map<string, PersonaRow[]>()
  for (const row of rows) {
    const bucket = chats.get(row.chatId)
    if (bucket) {
      bucket.push(row)
    } else {
      chats.set(row.chatId, [row])
    }
  }

  // Name -> person, for matching a name in your own sentences. A short name
  // is only matched when it is unambiguous across the graph.
  const nameOwners = new Map<string, string[]>()
  for (const [mid, person] of people) {
    if (!person.name) {
      continue
    }
    const candidates = new Set<string>([person.name])
    if (person.name.length >= 3) {
      candidates.add(person.name.slice(-2))
    }
    for (const candidate of candidates) {
      const owners = nameOwners.get(candidate) ?? []
      owners.push(mid)
      nameOwners.set(candidate, owners)
    }
  }

  const nodes = new Map<string, PersonaNode>()
  for (const [mid, person] of people) {
    nodes.set(mid, {
      mid,
      name: person.name,
      roles: [],
      evidence: [],
      addresses: [],
      conversations: [],
      voice: null,
    })
  }

  // Evidence: what the conversations actually show about each person. This is
  // the part yomi can say on its own — the address form used with them, the
  // work delegated to them, and their most substantial line — each quoted.
  // It never names a role; the model reading this decides what it means.
  const evidenceSeen = new Set<string>()
  const namedSeen = new Set<string>()
  for (const item of collectEvidence(rows as EvidenceRow[], selfMid)) {
    const node = nodes.get(item.mid)
    if (!node) {
      continue
    }
    const key = `${item.mid}|${item.kind}|${item.form ?? item.text}`
    if (evidenceSeen.has(key)) {
      continue
    }
    evidenceSeen.add(key)
    node.evidence.push({
      kind: item.kind,
      form: item.form,
      text: item.text,
      occurrences: item.occurrences,
      source: item.source,
    })
  }

  // Address forms: what you call them at the start of a message, in a
  // one-to-one conversation where there is no other candidate.
  const addressSeen = new Set<string>()
  for (const [chatId, chatRows] of chats) {
    const others = new Set(
      chatRows
        .map((r) => r.fromMid)
        .filter((mid): mid is string => !!mid && mid !== selfMid),
    )
    if (others.size !== 1) {
      continue
    }
    const mid = [...others][0]
    const node = nodes.get(mid)
    if (!node) {
      continue
    }
    for (const row of chatRows) {
      if (row.fromMid !== selfMid) {
        continue
      }
      const form = addressFormOf(row.text)
      if (!form) {
        continue
      }
      const key = `${mid}|${form}`
      if (addressSeen.has(key)) {
        continue
      }
      addressSeen.add(key)
      node.addresses.push({
        form,
        evidence: oneLine(row.text),
        source: { chatId, chatName: row.chatName },
      })
      break
    }
  }

  // Roles that a reader named. These come from the `persona_facts` table,
  // which holds what someone concluded about a person together with the
  // sentence it was based on. A fact is matched to a person by MID when it
  // has one, and otherwise by name — a name that matches exactly one person
  // in the graph. A fact about somebody who never appears in the index still
  // gets a node, because the point of the fact is to describe them.
  let statedFacts = 0
  for (const fact of facts) {
    let mid: string | undefined
    if (fact.subjectMid && nodes.has(fact.subjectMid)) {
      mid = fact.subjectMid
    } else {
      const candidates = nameOwners.get(fact.subjectName)
      mid = candidates?.length === 1 ? candidates[0] : undefined
    }
    if (!mid) {
      // Unknown person: keep them in the graph under their stated name. A
      // second fact about the same name must add to that node, not replace it.
      mid = `stated:${fact.subjectName}`
      if (!nodes.has(mid)) {
        nodes.set(mid, {
          mid,
          name: fact.subjectName,
          roles: [],
          evidence: [],
          addresses: [],
          conversations: [],
          voice: null,
        })
      }
    }
    const node = nodes.get(mid)
    if (!node) {
      continue
    }
    const key = `${mid}|${fact.term}`
    if (namedSeen.has(key)) {
      continue
    }
    namedSeen.add(key)
    statedFacts += 1
    node.roles.push({
      term: fact.term,
      category: normalizeRoleCategory(fact.category),
      evidence: oneLine(fact.evidence),
      source: { chatId: 'persona-facts', chatName: '使用者口述' },
      origin: fact.origin,
      instances: fact.instances,
      confidence: fact.confidence,
    })
  }

  // Conversation behaviour and the other person's own voice.
  for (const [chatId, chatRows] of chats) {
    const participants = new Set(
      chatRows
        .map((r) => r.fromMid)
        .filter((mid): mid is string => !!mid && mid !== selfMid),
    )
    const yourMessages = chatRows.filter((r) => r.fromMid === selfMid).length
    const timed = chatRows
      .filter((r) => r.createdTime != null)
      .map((r) => ({ fromMid: r.fromMid, createdTime: r.createdTime ?? 0 }))
    const rhythm = replyRhythmHours(timed, selfMid)
    for (const mid of participants) {
      const node = nodes.get(mid)
      if (!node) {
        continue
      }
      const theirMessages = chatRows.filter((r) => r.fromMid === mid).length
      const total = theirMessages + yourMessages
      node.conversations.push({
        chatId,
        chatName: chatRows[0].chatName,
        theirMessages,
        yourMessages,
        reciprocity: total === 0 ? 0 : theirMessages / total,
        rhythmHours: rhythm,
      })
    }
  }

  for (const [mid, person] of people) {
    const node = nodes.get(mid)
    if (!node) {
      continue
    }
    if (person.texts.length >= 20) {
      const profile = analyzeNarrative(person.texts)
      node.voice = condenseVoice(profile, person.texts)
    }
  }

  // Edges: people who appear in the same conversation as you.
  const edgeMap = new Map<string, PersonaEdge>()
  for (const [chatId, chatRows] of chats) {
    const participants = [
      ...new Set(
        chatRows
          .map((r) => r.fromMid)
          .filter((mid): mid is string => !!mid && mid !== selfMid),
      ),
    ].sort()
    for (let i = 0; i < participants.length; i++) {
      for (let j = i + 1; j < participants.length; j++) {
        const a = participants[i]
        const b = participants[j]
        const key = `${a}|${b}`
        const edge = edgeMap.get(key)
        if (edge) {
          edge.chatIds.push(chatId)
        } else {
          edgeMap.set(key, { a, b, chatIds: [chatId] })
        }
      }
    }
  }

  const personList = [...nodes.values()].sort((a, b) => {
    const aMessages = a.conversations.reduce(
      (sum, c) => sum + c.theirMessages,
      0,
    )
    const bMessages = b.conversations.reduce(
      (sum, c) => sum + c.theirMessages,
      0,
    )
    return bMessages - aMessages
  })

  const guide = buildGuide(personList, edgeMap)

  return {
    selfMid,
    people: personList,
    edges: [...edgeMap.values()],
    guide,
    method: {
      heuristic: true,
      sampleSize: rows.length,
      conversationCount: chats.size,
      excludedConversations: 0,
      edgeCount: edgeMap.size,
      edgesShown: edgeMap.size,
      namedRoles: statedFacts,
      evidenceCount: evidenceSeen.size,
    },
  }
}

/**
 * Turn the graph into briefing lines. Every line names its evidence.
 *
 * @param people - The people in the graph, most active first.
 * @param edges - Shared-conversation edges.
 * @returns Human-readable guidance lines.
 */
function buildGuide(
  people: PersonaNode[],
  edges: Map<string, PersonaEdge>,
): string[] {
  const lines: string[] = []
  for (const person of people) {
    const label = person.name ?? person.mid
    if (person.roles.length > 0) {
      for (const role of person.roles) {
        const origin = role.origin === 'stated' ? '（你口述）' : ''
        lines.push(
          `${label}：角色=${role.term}(${role.category})〔信心${role.confidence.toFixed(2)}〕${origin}，依據〈${role.evidence}〉`,
        )
      }
    }
    if (person.addresses.length > 0) {
      const address = person.addresses[0]
      lines.push(
        `${label}：你稱呼為「${address.form}」，依據〈${address.evidence}〉`,
      )
    }
    const conversation = person.conversations[0]
    if (conversation) {
      const rhythm =
        conversation.rhythmHours == null
          ? '無可估的回覆間隔'
          : `你回覆的中位間隔 ${conversation.rhythmHours.toFixed(1)} 小時`
      lines.push(
        `${label}：對話 ${conversation.theirMessages}／${conversation.yourMessages} 則，你回覆比例 ${Math.round(conversation.reciprocity * 100)}%，${rhythm}`,
      )
    }
    const voice = person.voice
    if (voice?.sufficient) {
      const act = voice.topAct
      const honorific = voice.dominantHonorific
      lines.push(
        `${label}：說話風格=${act ? `${act.label}最多(${Math.round(act.rate * 100)}%)` : '樣本不足'}${honorific ? `，稱呼以「${honorific}」為主` : ''}（樣本${voice.sampleSize}則）`,
      )
    }
  }
  const shared = [...edges.values()].filter((edge) => edge.chatIds.length > 0)
  if (shared.length > 0) {
    const pairs = shared
      .slice(0, 5)
      .map((edge) => {
        const a = people.find((p) => p.mid === edge.a)?.name ?? edge.a
        const b = people.find((p) => p.mid === edge.b)?.name ?? edge.b
        return `${a}×${b}(${edge.chatIds.length}個共同對話)`
      })
      .join('、')
    lines.push(`同一對話中出現的人：${pairs}`)
  }
  lines.push(
    'yomi 不替人命名角色：它沒有角色詞表，也不跑任何模型。每個人附的是證據——你怎麼稱呼對方、你交付給對方的工作、對方最有力的一句話，全部是你自己的原話；角色由讀這份結果的模型自己判斷，再用 add_persona_fact 寫回來。',
  )
  return lines
}
