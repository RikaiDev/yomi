/**
 * LINE core directory/runtime capability.
 */

import { fetchStickerPackageMeta } from '../client/sticker-meta.js'
import { createContactQueryService } from './contact-query-service.js'
import { createGroupQueryService } from './group-query-service.js'

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
      return service.nameCache.get(mid) || mid
    },

    /**
     * Fetch a LINE contact profile through the explicit contact-query boundary.
     *
     * @param mid - LINE contact MID.
     * @returns LINE contact profile.
     */
    async getContact(mid: string): Promise<any> {
      return createContactQueryService(() => service.client).getContact(mid)
    },

    /**
     * Fetch a LINE group profile through the explicit group-query boundary.
     *
     * @param groupId - LINE group MID.
     * @returns LINE group profile.
     */
    async getGroup(groupId: string): Promise<any> {
      return createGroupQueryService(() => service.client).getGroup(groupId)
    },

    /**
     * List the sticker packages the account owns (and can therefore send).
     *
     * @param language - Locale for package titles (default 'en').
     * @returns Owned sticker packages: { packageId, title, version }.
     */
    async listStickerPackages(language = 'en'): Promise<any[]> {
      return service.client.getOwnedStickerPackages(language)
    },

    /**
     * Search the account's OWNED sticker packages by title substring, and
     * expand each match into its sendable individual sticker ids (via the
     * public sticker CDN) so send_sticker can be called directly.
     *
     * @param query - Case-insensitive substring to match against package titles.
     * @param language - Locale for package titles (default 'en').
     * @param limit - Max matching packages to expand (default 8).
     * @returns Matching packages with their sticker ids.
     */
    async searchStickerPackages(
      query: string,
      language = 'en',
      limit = 8,
    ): Promise<{ total: number; packages: any[] }> {
      const owned = await service.client.getOwnedStickerPackages(language)
      const needle = (query ?? '').trim().toLowerCase()
      const matches = needle
        ? owned.filter((p: any) =>
            String(p.title ?? '')
              .toLowerCase()
              .includes(needle),
          )
        : owned
      const top = matches.slice(0, limit)
      const packages = await Promise.all(
        top.map(async (p: any) => {
          const meta = await fetchStickerPackageMeta(p.packageId).catch(
            () => null,
          )
          return {
            packageId: p.packageId,
            version: p.version,
            title: p.title,
            titles: meta?.title ?? {},
            stickerIds: meta?.stickerIds ?? [],
          }
        }),
      )
      return { total: matches.length, packages }
    },
  }
}
