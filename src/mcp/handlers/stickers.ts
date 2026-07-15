import {
  fetchStickerImage,
  fetchStickerPackageMeta,
} from '../../line/client/sticker-meta.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { toolError } from './shared.js'

/**
 * Handle `preview_sticker` — render sticker images so the caller can SEE them
 * (returns MCP image content from the public sticker CDN). With `stickerId`,
 * previews that one sticker; otherwise previews the first `limit` stickers of
 * `packageId`. Each image is preceded by a text line naming its ids so the
 * caller can map an image back to a (stickerId, packageId) for send_sticker.
 * Read-only.
 *
 * @param service - Resumed LineProtocolService (unused; CDN-only).
 * @param args - Tool arguments.
 * @returns MCP tool result with interleaved id labels and images.
 */
export async function handlePreviewSticker(
  _service: LineProtocolService,
  args: { packageId: string; stickerId?: string; limit?: number },
) {
  if (!args?.packageId) {
    return toolError('packageId is required.')
  }
  let ids: string[]
  if (args.stickerId) {
    ids = [args.stickerId]
  } else {
    const meta = await fetchStickerPackageMeta(args.packageId)
    if (!meta) {
      return toolError(
        `No sticker package found for packageId "${args.packageId}".`,
      )
    }
    ids = meta.stickerIds.slice(0, args.limit ?? 8)
  }

  const content: any[] = []
  for (const id of ids) {
    const img = await fetchStickerImage(id)
    if (!img) {
      continue
    }
    content.push({
      type: 'text' as const,
      text: `stickerId ${id} (packageId ${args.packageId}) — pass these to send_sticker`,
    })
    content.push({
      type: 'image' as const,
      data: img.toString('base64'),
      mimeType: 'image/png',
    })
  }
  if (content.length === 0) {
    return toolError('No sticker previews available for that package/sticker.')
  }
  return { content }
}

/**
 * Handle `list_stickers` — the sticker packages the account owns (and can
 * therefore send). Read-only.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleListStickers(
  service: LineProtocolService,
  args: { language?: string },
) {
  const packages = await service.listStickerPackages(args?.language)
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ total: packages.length, packages }, null, 2),
      },
    ],
  }
}

/**
 * Handle `search_stickers` — search the account's OWNED sticker packages by
 * title and expand matches into individual sticker ids ready for send_sticker.
 * Read-only.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleSearchStickers(
  service: LineProtocolService,
  args: { query: string; language?: string; limit?: number },
) {
  if (!args?.query) {
    return toolError('query is required.')
  }
  const result = await service.searchStickerPackages(
    args.query,
    args.language,
    args.limit,
  )
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  }
}
