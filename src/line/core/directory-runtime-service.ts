/**
 * LINE core directory/runtime capability.
 */

import { createContactQueryService } from './contact-query-service.js';
import { createGroupQueryService } from './group-query-service.js';

/**
 * Create the directory runtime capability bound to one LINE protocol service.
 *
 * @param service - Mutable LINE protocol service runtime.
 * @returns Directory and lightweight runtime methods.
 */
export function createDirectoryRuntimeService(service: any) {
  return {
    /**
     * Resolve a display name for one MID from the in-memory cache.
     *
     * @param mid - The user or group MID.
     * @returns Cached name or the MID itself.
     */
    resolveName(mid: string): string {
      return service.nameCache.get(mid) || mid;
    },

    /**
     * Fetch a LINE contact profile through the explicit contact-query boundary.
     *
     * @param mid - LINE contact MID.
     * @returns LINE contact profile.
     */
    async getContact(mid: string): Promise<any> {
      return createContactQueryService(() => service.client).getContact(mid);
    },

    /**
     * Fetch a LINE group profile through the explicit group-query boundary.
     *
     * @param groupId - LINE group MID.
     * @returns LINE group profile.
     */
    async getGroup(groupId: string): Promise<any> {
      return createGroupQueryService(() => service.client).getGroup(groupId);
    },
  };
}
