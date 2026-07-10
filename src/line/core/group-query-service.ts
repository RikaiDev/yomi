import { requireLineClient } from './client-runtime.js';

/**
 * Build the LINE group query boundary for a connected runtime.
 *
 * @param getClient - Deferred LINE client accessor
 * @returns Group query methods
 */
export function createGroupQueryService(getClient) {
  return {
    /**
     * Fetch a LINE group profile.
     *
     * @param groupId - LINE group MID
     * @returns LINE group profile
     */
    async getGroup(groupId) {
      return requireLineClient(getClient).getGroup(groupId);
    },
  };
}
