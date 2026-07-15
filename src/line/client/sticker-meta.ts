/**
 * Sticker package metadata from LINE's PUBLIC sticker CDN.
 *
 * getOwnedStickerPackages (ShopService) returns package-level info; to actually
 * send a sticker LINE needs an individual sticker id (STKID). Those live in the
 * package's public productInfo.meta on the sticker CDN — no auth, no account
 * data sent (only the public packageId), so this is safe to fetch for any owned
 * package the caller wants to expand into sendable sticker ids.
 */

const CDN = 'https://stickershop.line-scdn.net/stickershop/v1/product'

/** One sticker package's public metadata, trimmed to what sending needs. */
export interface StickerPackageMeta {
  packageId: string
  /** Localized titles keyed by locale (e.g. { en, zh_TW }). */
  title: Record<string, string>
  /** Individual sticker ids (STKID) in the package. */
  stickerIds: string[]
}

/**
 * Fetch one sticker package's public metadata (title + individual sticker ids).
 *
 * @param packageId - LINE sticker package id (STKPKGID).
 * @returns Package metadata, or null when the CDN has no such package.
 */
export async function fetchStickerPackageMeta(
  packageId: string,
): Promise<StickerPackageMeta | null> {
  const res = await fetch(`${CDN}/${packageId}/android/productInfo.meta`)
  if (!res.ok) {
    return null
  }
  const meta: any = await res.json()
  const stickers = Array.isArray(meta?.stickers) ? meta.stickers : []
  return {
    packageId: String(meta?.packageId ?? packageId),
    title:
      meta?.title && typeof meta.title === 'object'
        ? (meta.title as Record<string, string>)
        : {},
    stickerIds: stickers
      .map((s: any) => (s?.id != null ? String(s.id) : null))
      .filter((id: string | null): id is string => id !== null),
  }
}
