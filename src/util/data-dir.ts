/**
 * Where Yomi keeps its on-disk state (message index, E2EE key cache, and the
 * credential file on platforms without a keychain).
 *
 * This has to avoid two tempting-but-wrong answers, and the project shipped
 * both of them at once:
 *
 *   - `process.cwd()` — an MCP client spawns the server with whatever working
 *     directory it likes, and Claude Desktop uses `/`. The E2EE cache was
 *     cwd-relative, so it tried to write `/data/line-e2ee-cache.json`, failed,
 *     and had the failure swallowed. Every peer key was refetched on every run
 *     and no group-key epoch was ever persisted.
 *
 *   - the install directory — `npx @rikaidev/yomi` unpacks under
 *     `~/.npm/_npx/<hash>/`, which npm deletes on any cache refresh. The index
 *     was resolved relative to the module, so it lived there: one
 *     `npx cache clean` would take the whole message index with it. Group-key
 *     epochs are the sharp edge, since LINE only ever returns the latest one.
 *
 * A stable per-user directory is the only location that survives both. Honour
 * the platform convention so it lands where a user would look for it, and let
 * YOMI_DATA_DIR override for tests and custom setups.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Resolve Yomi's data directory. Never cwd-relative, never install-relative.
 *
 * @returns Absolute path to the directory Yomi's state lives in.
 */
export function resolveYomiDataDir(): string {
  const override = process.env.YOMI_DATA_DIR
  if (override) {
    return override
  }
  const home = homedir()
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'yomi')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return join(appData, 'yomi')
  }
  const xdg = process.env.XDG_DATA_HOME ?? join(home, '.local', 'share')
  return join(xdg, 'yomi')
}

/**
 * Resolve one file inside Yomi's data directory.
 *
 * @param name - File name, e.g. `search-index.db`.
 * @returns Absolute path to that file.
 */
export function yomiDataPath(name: string): string {
  return join(resolveYomiDataDir(), name)
}
