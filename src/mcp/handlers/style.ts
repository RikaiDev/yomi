/**
 * MCP handler for `get_style_profile` — returns a compact "digital twin"
 * style card so the AI can draft LINE replies that fully match the user's
 * voice: tone, phrasing, message segmentation/bursting, and sticker habits.
 *
 * Reads only the local search index (no network). Works if the index has
 * the user's sent messages; session is only needed to know the user's MID.
 */

import type { LineProtocolService } from '../../line/core/service.js'
import { getStyleCard } from '../../search/style-profile.js'
import { jsonResult, toolError } from './shared.js'

export async function handleGetStyleProfile(
  service: LineProtocolService,
  args: { chatId?: string },
) {
  const userMid = service.profile?.mid
  if (!userMid) {
    return toolError(
      "No LINE session — cannot determine the user's MID. " +
        'Log in first, then run collect_messages to populate the index.',
    )
  }

  try {
    const card = getStyleCard(userMid, args.chatId)

    if (!card || (card.textSampleSize === 0 && card.stickerSampleSize === 0)) {
      return jsonResult({
        ok: false,
        message:
          'No sent messages found in the search index. Run collect_messages to index your messages, then retry.',
      })
    }

    return jsonResult({ ok: true, ...card })
  } catch (error: any) {
    return toolError(
      `Failed to build style profile: ${error?.message ?? String(error)}`,
    )
  }
}
