/**
 * MCP handler for `get_persona_graph` — returns who the people in your
 * conversations are.
 *
 * The style profile answers "how do I write"; this answers "who am I talking
 * to, and how do they write". For every other person in the local index it
 * reports the roles you stated for them, how you address them, how you
 * behave with them, and how they write — each role carrying the sentence
 * that stated it.
 *
 * Reads only the local search index (no network, no live session). The
 * excluded-chat denylist is honoured, so an excluded conversation
 * contributes nothing.
 */

import { getPersonaGraph, roleCategoryOf } from '../../search/persona-graph.js'
import { listPersonaFacts, upsertPersonaFact } from '../../search/store.js'
import { jsonResult, toolError } from './shared.js'

/**
 * MCP handler for `add_persona_fact` — records a fact about a person that the
 * owner stated outside LINE.
 *
 * The persona graph can only report a role that was written down somewhere. A
 * role told to an assistant never appears in the LINE index, so this is the
 * path that lets it into the graph — with the owner's own sentence kept as
 * the evidence, exactly as a role read from a message would be.
 */
export async function handleAddPersonaFact(args: {
  subjectName: string
  subjectMid?: string
  term: string
  category?: string
  evidence: string
}) {
  try {
    const subjectName = args?.subjectName?.trim()
    const term = args?.term?.trim()
    const evidence = args?.evidence?.trim()
    if (!subjectName || !term || !evidence) {
      return toolError(
        'subjectName, term and evidence are all required — the evidence is your own sentence that states the role.',
      )
    }
    const requested = args?.category?.trim()
    const category = requested ?? roleCategoryOf(term) ?? 'household'
    const id = upsertPersonaFact({
      subjectMid: args?.subjectMid?.trim() ?? null,
      subjectName,
      term,
      category,
      evidence,
    })
    const facts = listPersonaFacts()
    return jsonResult({
      ok: true,
      id,
      fact: { subjectName, term, category, evidence },
      totalFacts: facts.length,
    })
  } catch (error: any) {
    return toolError(
      `Failed to store persona fact: ${error?.message ?? String(error)}`,
    )
  }
}

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

    return jsonResult({ ok: true, ...graph })
  } catch (error: any) {
    return toolError(
      `Failed to build persona graph: ${error?.message ?? String(error)}`,
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
