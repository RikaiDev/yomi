import { requireLineClient } from './client-runtime.js'

/**
 * Build the LINE contact query boundary for a connected runtime.
 *
 * @param getClient - Deferred LINE client accessor
 * @returns Contact query methods
 */
export function createContactQueryService(getClient) {
  return {
    /**
     * Fetch a LINE contact profile.
     *
     * @param mid - LINE contact MID
     * @returns LINE contact profile
     */
    async getContact(mid) {
      return requireLineClient(getClient).getContact(mid)
    },
  }
}
