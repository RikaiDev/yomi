/**
 * Yomi privacy-policy loader — the single source of truth for the
 * data-capture disclosure is the repo-root `PRIVACY.md` file, NOT any
 * string literal in code. Both the MCP server `instructions` (surfaced to
 * the client/model on connect) and the `get_scope_policy` tool read the
 * policy prose from here, so the disclosure never drifts between the two.
 *
 * The file is read synchronously (so it is available at Server construction
 * time) and memoized for the process lifetime.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolve PRIVACY.md relative to this module (src/mcp/ -> <repo>/PRIVACY.md),
// NOT process.cwd(): an MCP client may spawn the server from any working
// directory, so a cwd-relative path would miss the file. Same REPO_ROOT
// derivation pattern as src/search/store.ts.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PRIVACY_PATH = join(REPO_ROOT, 'PRIVACY.md')

let cachedPolicy: string | null = null

/**
 * Read and memoize the canonical privacy-policy text from the repo-root
 * PRIVACY.md. The prose lives only in that file — this is how both the
 * server `instructions` and `get_scope_policy` stay in lockstep with a
 * single edit.
 *
 * @returns The full PRIVACY.md contents.
 */
export function getPrivacyPolicyText(): string {
  if (cachedPolicy === null) {
    cachedPolicy = readFileSync(PRIVACY_PATH, 'utf8')
  }
  return cachedPolicy
}
