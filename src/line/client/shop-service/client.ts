/**
 * LINE ShopService capability — the unified shop at /TSHOP4.
 *
 * Only the sticker-ownership read is implemented: getOwnedProductSummaries with
 * shopId "stickershop" returns the sticker PACKAGES the authenticated account
 * owns (and can therefore send — LINE rejects sending a non-owned sticker with
 * "sticker is not owned by the user"). Response summary fields used: 1 =
 * packageId, 11 = title, 21 = version. Field 3 of the return is the total count,
 * used to paginate.
 */

import { i32Field, stringField, structField } from '../../core/thrift/index.js'

/** One owned sticker package. */
export interface OwnedStickerPackage {
  packageId: string
  title: string
  version: string
}

/** Sticker shop id for the unified shop's getOwnedProductSummaries. */
const STICKER_SHOP_ID = 'stickershop'
/** Unified shop endpoint. */
const SHOP_PATH = '/TSHOP4'

/**
 * Create the ShopService capability bound to one LINE client runtime.
 *
 * @param runtime - LINE client runtime exposing sendCompact.
 * @returns Shop query methods bound to the runtime.
 */
export function createShopClient(runtime) {
  return {
    /**
     * List the sticker packages the authenticated account owns, paginating
     * until the server's reported total is reached.
     *
     * @param language - BCP-47-ish language for titles (default 'en').
     * @param country - Country code for the shop locale (default 'TW').
     * @returns Owned sticker packages.
     */
    async getOwnedStickerPackages(
      language = 'en',
      country = 'TW',
    ): Promise<OwnedStickerPackage[]> {
      const packages: OwnedStickerPackage[] = []
      const limit = 200
      let total = Number.POSITIVE_INFINITY

      while (packages.length < total) {
        const res = await runtime.sendCompact(
          SHOP_PATH,
          'getOwnedProductSummaries',
          [
            stringField(2, STICKER_SHOP_ID),
            i32Field(3, packages.length),
            i32Field(4, limit),
            structField(5, [stringField(1, language), stringField(2, country)]),
          ],
        )
        const ret = res?.fields?.[0]
        const summaries = Array.isArray(ret?.[1]) ? ret[1] : []
        total = Number(ret?.[3] ?? summaries.length)
        for (const s of summaries) {
          if (s?.[1] == null) {
            continue
          }
          packages.push({
            packageId: String(s[1]),
            title: String(s[11] ?? ''),
            version: String(s[21] ?? '1'),
          })
        }
        if (summaries.length === 0 || summaries.length < limit) {
          break
        }
      }
      return packages
    },
  }
}
