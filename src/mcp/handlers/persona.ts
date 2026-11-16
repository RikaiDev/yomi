/**
 * MCP handler for `get_persona_graph` — returns who the people in your
 * conversations are, and the evidence for it.
 *
 * The style profile answers "how do I write"; this answers "who am I talking
 * to". For every other person in the local index it reports the quotable
 * evidence — the address form you use with them, the work you delegate to
 * them, their most substantial line — and the roles that have been named
 * for them, each with the sentence it rests on.
 *
 * Yomi does not decide what someone is. It has no vocabulary of roles and
 * runs no model of its own, so the answer to "who is this person" comes from
 * the model reading this result: you are being handed evidence, and you name
 * it. Whatever you conclude can be written back with `add_persona_fact`, and
 * the next read shows it — so the graph gets sharper over time instead of
 * being rebuilt from scratch every time.
 *
 * Reads only the local search index (no network, no live session). The
 * excluded-chat denylist is honoured, so an excluded conversation
 * contributes nothing.
 */

import {
  getPersistedPersona,
  getPersonaGraph,
} from '../../search/persona-graph.js'
import { listPersonaFacts, upsertPersonaFact } from '../../search/store.js'
import { jsonResult, toolError } from './shared.js'

/**
 * MCP handler for `add_persona_fact` — records what you concluded about a
 * person from the evidence.
 *
 * The persona graph can only report a role that was written down somewhere.
 * The evidence yomi hands you is the raw material; this is where your
 * reading of it becomes part of the graph. The sentence you based the name
 * on is kept as the evidence, exactly as a role read from a message would
 * be — so a later reader can check the conclusion against the words it came
 * from.
 */
export async function handleAddPersonaFact(args: {
  subjectName: string
  subjectMid?: string
  term: string
  category?: string
  evidence: string
  origin?: string
  instances?: number
  confidence?: number
}) {
  try {
    const subjectName = args?.subjectName?.trim()
    const term = args?.term?.trim()
    const evidence = args?.evidence?.trim()
    if (!subjectName || !term || !evidence) {
      return toolError(
        'subjectName, term and evidence are all required — the evidence is the sentence you based the name on.',
      )
    }
    const category = args?.category?.trim() || 'other'
    const origin = args?.origin === 'stated' ? 'stated' : 'named'
    const instances =
      typeof args?.instances === 'number' && args.instances > 0
        ? Math.round(args.instances)
        : 1
    const confidence =
      typeof args?.confidence === 'number' &&
      args.confidence >= 0 &&
      args.confidence <= 1
        ? args.confidence
        : 0.5
    const id = upsertPersonaFact({
      subjectMid: args?.subjectMid?.trim() ?? null,
      subjectName,
      term,
      category,
      evidence,
      origin,
      instances,
      confidence,
    })
    const facts = listPersonaFacts()
    return jsonResult({
      ok: true,
      id,
      fact: {
        subjectName,
        term,
        category,
        evidence,
        origin,
        instances,
        confidence,
      },
      totalFacts: facts.length,
    })
  } catch (error: any) {
    return toolError(
      `Failed to store persona fact: ${error?.message ?? String(error)}`,
    )
  }
}

/**
 * MCP handler for `get_persona_graph`.
 *
 * @param args - Tool arguments.
 * @returns The persona graph, as JSON.
 */
export async function handleGetPersonaGraph(args: { limit?: number }) {
  try {
    const selfMid = await resolveSelfMid()
    if (!selfMid) {
      return toolError(
        'Cannot determine your own MID — no stored LINE identity. ' +
          'Log in first (yomi login), then run collect_messages to populate the index.',
      )
    }

    const graph = getPersonaGraph(selfMid, {
      limit: typeof args?.limit === 'number' ? args.limit : undefined,
    })

    if (graph.people.length === 0) {
      return jsonResult({
        ok: false,
        message:
          'No other people found in the search index. Run collect_messages to index conversations, then retry.',
      })
    }

    return jsonResult({
      ok: true,
      ...graph,
      instruction:
        'Yomi does not name roles itself — it has no role vocabulary and runs no model. ' +
        'Each person carries evidence: the address form you use with them, the work you delegate to them, ' +
        'and their most substantial line, all quoted. Read that evidence and decide who each person is. ' +
        'Then write your conclusion back with add_persona_fact, passing the quoted sentence as evidence, ' +
        'so the next read starts from your conclusion instead of re-deriving it.',
    })
  } catch (error: any) {
    return toolError(
      `Failed to build persona graph: ${error?.message ?? String(error)}`,
    )
  }
}

/**
 * MCP handler for `get_persona_evidence` — the persisted evidence, without
 * rescanning the corpus.
 *
 * `get_persona_graph` rebuilds the graph on every call, which is the right
 * thing when you want the whole picture. This one reads what the background
 * pass last collected, which is the cheap path for a caller that only needs
 * the evidence itself.
 *
 * @param args - Tool arguments.
 * @returns The persisted evidence, as JSON.
 */
export async function handleGetPersonaEvidence() {
  try {
    const selfMid = await resolveSelfMid()
    if (!selfMid) {
      return toolError(
        'Cannot determine your own MID — no stored LINE identity. Log in first (yomi login).',
      )
    }
    const persisted = getPersistedPersona(selfMid)
    return jsonResult({ ok: true, ...persisted })
  } catch (error: any) {
    return toolError(
      `Failed to read persona evidence: ${error?.message ?? String(error)}`,
    )
  }
}

/**
 * Read the account owner's own MID from the stored credentials, so the graph
 * knows who "you" are without a live LINE session.
 *
 * @returns The stored MID, or null when there is none.
 */
async function resolveSelfMid(): Promise<string | null> {
  try {
    const { CredentialStore } = await import('../../auth/credential-store.js')
    const { yomiDataPath } = await import('../../util/data-dir.js')
    const store = new CredentialStore(
      'line',
      yomiDataPath('line-credentials.json'),
    )
    return (await store.get('line_mid')) ?? null
  } catch {
    return null
  }
}
