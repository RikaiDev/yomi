/**
 * CLI: `yomi persona-graph` — print the persona graph as JSON.
 *
 * Reads the local search index only; no LINE session is required. The account
 * owner's own MID comes from the stored credentials, so the graph knows which
 * speaker is "you".
 *
 * Usage:
 *   yomi persona-graph [limit]
 */

import { CredentialStore } from '../auth/credential-store.js'
import { getPersonaGraph } from '../search/persona-graph.js'
import { yomiDataPath } from '../util/data-dir.js'

/**
 * Print the persona graph as one JSON line.
 *
 * @param args - Optional positional limit on how many messages are read.
 * @returns Process exit code (0 on success, 1 when the identity is unknown).
 */
export async function cliPersonaGraph(args: string[] = []): Promise<number> {
  const limit = args.length > 0 ? Number(args[0]) : undefined
  const store = new CredentialStore(
    'line',
    yomiDataPath('line-credentials.json'),
  )
  const selfMid = await store.get('line_mid')
  if (!selfMid) {
    console.error(
      'persona-graph: no stored LINE identity. Run `yomi login` first.',
    )
    return 1
  }
  const graph = getPersonaGraph(selfMid, {
    limit: Number.isFinite(limit) ? limit : undefined,
  })
  console.log(JSON.stringify(graph))
  return 0
}
