/**
 * "Is this copy of Yomi out of date?" — asked once at startup, answered to
 * the model through the MCP `instructions` so it can tell the human.
 *
 * Why this exists: the drag-and-drop `.mcpb` bundle has NO auto-update. The
 * MCPB manifest spec defines no update URL or endpoint (its `version` is
 * plain metadata), and Claude Desktop only auto-updates extensions installed
 * from the official directory — "for privately distributed extensions, users
 * will need to install updated .mcpb files manually". Yomi's bundles are
 * attached to GitHub Releases, so without this a user can sit on an old
 * build indefinitely without ever knowing.
 *
 * It cannot self-update: a bundle carries native binaries (onnxruntime-node,
 * sharp) and overwriting itself while running is neither safe nor portable.
 * Telling the human, with the right link for how they installed, is the whole
 * scope.
 *
 * PRIVACY. This is the ONE outbound request Yomi makes that is not to LINE,
 * and it is disclosed in PRIVACY.md. It sends no message content and no
 * account identifier — it is a plain GET of a public npm registry document.
 * What it does reveal to the registry is that some IP is running Yomi, and
 * (by what it does with the answer) roughly which version. `YOMI_NO_UPDATE_CHECK=1`
 * turns it off completely.
 */
import { YOMI_VERSION } from '../version.js'

/**
 * The registry document for the published package. Queried directly rather
 * than through `npm view`, which reads a CDN-cached view that lags behind a
 * publish by minutes.
 */
const LATEST_URL = 'https://registry.npmjs.org/@rikaidev/yomi/latest'

/** How long the check may take before startup gives up on it. */
const TIMEOUT_MS = 1500

/**
 * Compare two semver core versions (`major.minor.patch`).
 *
 * Pre-release suffixes are ignored on BOTH sides, which is deliberate: the
 * only question here is "is a newer release available", and a local
 * pre-release of the same core version should not nag.
 *
 * @param a - Left version.
 * @param b - Right version.
 * @returns Positive when `a` is newer, negative when older, 0 when equal.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/, '')
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

/**
 * How this copy of Yomi was installed, which decides what "update" means.
 * The `.mcpb` build stamps `YOMI_DISTRIBUTION=mcpb` into the manifest's
 * server env (scripts/build-mcpb.mjs); anything else is an npm/npx install.
 *
 * @returns The distribution channel.
 */
function distribution(): 'mcpb' | 'npm' {
  return process.env.YOMI_DISTRIBUTION === 'mcpb' ? 'mcpb' : 'npm'
}

/**
 * Build the notice handed to the model when a newer version exists.
 *
 * @param latest - The newest published version.
 * @returns Notice text, phrased for how this copy was installed.
 */
export function updateNotice(latest: string): string {
  const how =
    distribution() === 'mcpb'
      ? 'Desktop Extension bundles do NOT auto-update when installed by hand: the human has to ' +
        'download the new .mcpb for their platform from ' +
        'https://github.com/RikaiDev/yomi/releases/latest and drag it into Claude Desktop again ' +
        '(same extension, it replaces this one). Restart Claude Desktop after replacing the bundle.'
      : 'To update a shared local install, run `bun add -g @rikaidev/yomi@latest` (bun global) ' +
        'or `npm install -g @rikaidev/yomi@latest` (npm global). ' +
        'The running daemon restarts automatically on the next Yomi use to pick up the new version — ' +
        'no manual `yomi daemon restart` is needed. ' +
        'A plain `npx @rikaidev/yomi@latest` runs the new code once but does not permanently update an installed daemon.'
  return (
    `UPDATE AVAILABLE — this Yomi is ${YOMI_VERSION}; ${latest} has been published. ` +
    `${how} Mention this ONCE, early, in your own words, then carry on with what the user ` +
    'asked — it is not urgent and never a reason to refuse work.'
  )
}

/**
 * Ask the registry whether a newer Yomi has been published.
 *
 * Best-effort by construction: offline, slow, rate-limited, or malformed
 * answers all resolve to `null`. A version check must never delay or fail a
 * server that is otherwise ready to work.
 *
 * @returns The notice text when an update exists, otherwise null.
 */
export async function checkForUpdate(): Promise<string | null> {
  if (process.env.YOMI_NO_UPDATE_CHECK === '1') {
    return null
  }
  try {
    const response = await fetch(LATEST_URL, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: 'application/json' },
    })
    if (!response.ok) {
      return null
    }
    const body = (await response.json()) as { version?: unknown }
    const latest = typeof body.version === 'string' ? body.version : null
    if (!latest || compareVersions(latest, YOMI_VERSION) <= 0) {
      return null
    }
    return updateNotice(latest)
  } catch {
    // Offline is the normal case here, not an error worth surfacing.
    return null
  }
}
