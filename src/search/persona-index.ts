/**
 * Persona index — the evidence, kept current on its own.
 *
 * The graph is not something you refresh by hand. The capture loop already
 * runs in the background and knows when new messages land, so this module
 * hangs off it: after a sync it re-derives the evidence of the people in the
 * chats that changed (incremental), and on a timer it re-derives everything
 * (full). The result is written to the `persona_evidence` / `persona_nodes`
 * tables, so a reader gets the current picture without rescanning the
 * corpus.
 *
 * What is stored is evidence, not verdicts. Yomi holds no vocabulary of
 * roles and runs no model of its own: it hands over quotable lines, and the
 * model reading the tool decides what they mean. What that model concluded
 * is remembered separately (see the `persona_facts` table), so the next
 * reader starts from the previous reader's conclusions instead of starting
 * over.
 *
 * Two paths, on purpose
 * ----------------------
 *
 * Incremental is cheap and immediate, but it only sees the chats it was
 * told about. It cannot notice that a person's address form changed because
 * of something elsewhere — a new title you started using in a different
 * chat. The full pass can, because it reads everything. Running both means
 * the evidence is never more than one sync behind, and never stale for
 * longer than one timer tick.
 *
 * The evidence collection itself lives in ./persona-evidence.ts and is pure;
 * this module is the part that knows about the database and the clock.
 */

import {
  collectEvidence,
  type EvidenceRow,
  loadEvidenceRows,
  type PersonaEvidence,
} from './persona-evidence.js'
import {
  getPersonaState,
  listPersonaEvidence,
  listPersonaNodes,
  type PersonaEvidenceRecord,
  type PersonaNodeRecord,
  replacePersonaEvidence,
  replacePersonaEvidenceForMids,
} from './store.js'

/** How many messages the derivation reads. */
export const DERIVE_LIMIT = 20_000

/** How often the full re-derivation runs, in milliseconds. */
export const FULL_REDERIVE_INTERVAL_MS = 15 * 60 * 1000

/**
 * Group evidence into the shape the persona tables store.
 *
 * One node per person, holding the address forms used with them and the
 * evidence gathered for them.
 *
 * @param evidence - The collected evidence.
 * @returns The evidence records and the persona records.
 */
function toRecords(evidence: PersonaEvidence[]): {
  evidence: PersonaEvidenceRecord[]
  nodes: PersonaNodeRecord[]
} {
  const evidenceRecords: PersonaEvidenceRecord[] = evidence.map((item) => ({
    mid: item.mid,
    name: item.name,
    kind: item.kind,
    form: item.form,
    text: item.text,
    occurrences: item.occurrences,
    chatId: item.source.chatId,
    chatName: item.source.chatName,
    derivedAt: 0,
  }))
  const byPerson = new Map<string, PersonaNodeRecord>()
  for (const item of evidenceRecords) {
    const node = byPerson.get(item.mid) ?? {
      mid: item.mid,
      name: item.name,
      addresses: null,
      summary: null,
      derivedAt: 0,
    }
    node.name = item.name ?? node.name
    const summary = node.summary ? (JSON.parse(node.summary) as unknown[]) : []
    summary.push({
      kind: item.kind,
      form: item.form,
      text: item.text,
      occurrences: item.occurrences,
    })
    node.summary = JSON.stringify(summary)
    byPerson.set(item.mid, node)
  }
  return { evidence: evidenceRecords, nodes: [...byPerson.values()] }
}

/**
 * Re-derive the evidence for everyone in the corpus and write it out.
 *
 * @param selfMid - The account owner's LINE MID.
 * @returns How many pieces of evidence were derived.
 */
export function deriveAllEvidence(selfMid: string): number {
  const { rows } = loadEvidenceRows(DERIVE_LIMIT)
  const evidence = collectEvidence(rows as EvidenceRow[], selfMid)
  const { evidence: records, nodes } = toRecords(evidence)
  replacePersonaEvidence(records, nodes, rows.length)
  return records.length
}

/**
 * Re-derive the evidence of the people in the given chats.
 *
 * This is the incremental path: it runs after a sync, over the chats that
 * actually changed, so the evidence reflects new messages without a full
 * corpus scan. Evidence for people outside those chats is left alone — a
 * full pass will catch it.
 *
 * @param selfMid - The account owner's LINE MID.
 * @param chatIds - The chats whose messages changed.
 * @returns How many pieces of evidence were derived.
 */
export function deriveEvidenceForChats(
  selfMid: string,
  chatIds: string[],
): number {
  if (chatIds.length === 0) {
    return 0
  }
  const { rows } = loadEvidenceRows(DERIVE_LIMIT, chatIds)
  const derived = collectEvidence(rows as EvidenceRow[], selfMid)

  // Replace the rows of the people this derivation touched and leave everyone
  // else's rows in place. Rewriting the whole table on every message was the
  // index's largest write amplifier: every derivation deleted and reinserted
  // every row, so the WAL grew and checkpointed continuously.
  const touched = new Set(derived.map((item) => item.mid))
  const records = toRecords(derived)
  replacePersonaEvidenceForMids(
    records.evidence,
    records.nodes,
    [...touched],
    rows.length,
  )
  return derived.length
}

/**
 * Read the persisted evidence.
 *
 * @returns The evidence, the personas, and when the derivation ran.
 */
export function getPersistedEvidence(): {
  evidence: PersonaEvidenceRecord[]
  nodes: PersonaNodeRecord[]
  state: { derivedAt: number | null; messageCount: number; roleCount: number }
} {
  const state = getPersonaState()
  return {
    evidence: listPersonaEvidence(),
    nodes: listPersonaNodes(),
    state: state ?? { derivedAt: null, messageCount: 0, roleCount: 0 },
  }
}
