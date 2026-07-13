/**
 * LINE core runtime accessors.
 */

/**
 * Resolve the active LINE client or fail fast when the protocol service has
 * not established a session yet.
 *
 * @param getClient - Deferred LINE client accessor
 * @returns Connected LINE client instance
 */
export function requireLineClient(getClient) {
  const client = getClient()
  if (!client) {
    throw new Error('Not connected')
  }
  return client
}
