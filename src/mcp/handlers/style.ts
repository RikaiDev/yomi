/**
 * MCP handler for `get_style_profile` — returns the user's personal writing
 * style analysis so an AI assistant can draft LINE replies that sound like
 * the user rather than a generic template.
 *
 * Reads from the local search index (same DB as search_messages) — no
 * network calls, no external API. Works without a live LINE session as long
 * as the index has the user's own sent messages (collected via
 * collect_messages or background capture).
 */

import type { LineProtocolService } from '../../line/core/service.js'
import { buildStyleProfile } from '../../search/style-profile.js'
import { jsonResult, toolError } from './shared.js'

/**
 * Handle `get_style_profile` — return the user's personal writing style
 * profile, optionally focused on a specific conversation.
 *
 * @param service - Resumed LineProtocolService (used for profile.mid).
 * @param args - Tool arguments.
 * @returns MCP tool result with the style profile.
 */
export async function handleGetStyleProfile(
  service: LineProtocolService,
  args: { chatId?: string; sampleSize?: number },
) {
  const userMid = service.profile?.mid
  if (!userMid) {
    return toolError(
      "No LINE session — cannot determine the user's MID. " +
        'Log in first, then run collect_messages to populate the index.',
    )
  }

  const sampleSize = Math.min(Math.max(args.sampleSize ?? 50, 1), 200)

  try {
    const profile = buildStyleProfile(userMid, args.chatId, sampleSize)

    if (profile.sampleSize === 0) {
      return jsonResult({
        sampleSize: 0,
        message:
          'No sent messages found in the search index. Run collect_messages first to index your messages.',
      })
    }

    return jsonResult(profile)
  } catch (error: any) {
    return toolError(
      `Failed to build style profile: ${error?.message ?? String(error)}`,
    )
  }
}
