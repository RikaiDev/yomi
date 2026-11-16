/**
 * CLI: `yomi persona-fact` — record and list facts about people.
 *
 * The persona graph can only report a role that was written down somewhere.
 * A role the owner states to an assistant ("Yijun is my wife and our finance
 * person") never appears in the LINE index, so this command stores it in the
 * `persona_facts` table of the local search index, with the owner's own
 * sentence as the evidence.
 *
 * Usage:
 *   yomi persona-fact add <subjectName> <term> <evidence> [--mid <mid>] [--category <category>]
 *   yomi persona-fact list
 */

import { roleCategoryOf } from '../search/persona-graph.js'
import {
  deletePersonaFact,
  listPersonaFacts,
  upsertPersonaFact,
} from '../search/store.js'

/**
 * Parse `--key value` flags out of the argument list.
 *
 * @param args - The raw argument list.
 * @returns The positional arguments and the flag map.
 */
function parseArgs(args: string[]): {
  positional: string[]
  flags: Map<string, string>
} {
  const positional: string[] = []
  const flags = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = args[i + 1]
      if (value && !value.startsWith('--')) {
        flags.set(key, value)
        i++
      } else {
        flags.set(key, '')
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

/**
 * Record or list persona facts.
 *
 * @param args - Command arguments, starting with the subcommand.
 * @returns Process exit code.
 */
export async function cliPersonaFact(args: string[] = []): Promise<number> {
  const [command, ...rest] = args
  if (!command || command === 'list') {
    console.log(JSON.stringify({ facts: listPersonaFacts() }))
    return 0
  }
  if (command === 'remove') {
    const { positional } = parseArgs(rest)
    const [subjectName, term] = positional
    if (!subjectName || !term) {
      console.error(
        'persona-fact remove: usage: persona-fact remove <subjectName> <term>',
      )
      return 1
    }
    const removed = deletePersonaFact(subjectName, term)
    console.log(JSON.stringify({ ok: true, removed }))
    return 0
  }
  if (command !== 'add') {
    console.error(`persona-fact: unknown subcommand "${command}"`)
    return 1
  }
  const { positional, flags } = parseArgs(rest)
  const [subjectName, term, evidence] = positional
  if (!subjectName || !term || !evidence) {
    console.error(
      'persona-fact add: usage: persona-fact add <subjectName> <term> <evidence> [--mid <mid>] [--category <category>]',
    )
    return 1
  }
  const category = flags.get('category') || roleCategoryOf(term) || 'household'
  const id = upsertPersonaFact({
    subjectMid: flags.get('mid') || null,
    subjectName,
    term,
    category,
    evidence,
  })
  console.log(
    JSON.stringify({
      ok: true,
      id,
      fact: { subjectName, term, category, evidence },
    }),
  )
  return 0
}
