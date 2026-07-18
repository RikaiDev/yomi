/**
 * Yomi MCP name resolution — turns opaque LINE MIDs into display names.
 *
 * LINE MIDs are prefixed by conversation kind (u = 1:1 user, c = group,
 * r = room). For a 1:1 chat the chat id IS the other party's contact MID,
 * so it resolves through the same user-contact path as message senders.
 * Group/room titles resolve through TalkService getChats' chatName field.
 *
 * Every resolver batches unique MIDs into a single TalkService call and
 * reads/writes through LineProtocolService's existing nameCache /
 * chatCache, so a name is fetched over the network at most once per
 * process lifetime. Unresolvable MIDs are never given a fabricated
 * placeholder — callers get `null` and may fall back to the raw MID.
 */

import type { LineProtocolService } from '../line/core/service.js'

/**
 * Resolve display names for LINE user (contact) MIDs.
 *
 * @param service - Resumed LineProtocolService.
 * @param mids - User MIDs to resolve (duplicates and falsy values ignored).
 * @returns Map of MID to resolved display name (unresolved MIDs are omitted).
 */
export async function resolveUserNames(
  service: LineProtocolService,
  mids: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(mids.filter(Boolean)))
  const resolved = new Map<string, string>()
  const missing: string[] = []
  for (const mid of unique) {
    const cached = service.nameCache.get(mid)
    if (cached) {
      resolved.set(mid, cached)
    } else {
      missing.push(mid)
    }
  }
  if (missing.length > 0) {
    const contacts = await service.client.getContacts(missing)
    for (const contact of contacts as any[]) {
      if (contact?.mid && contact.displayName) {
        service.nameCache.set(contact.mid, contact.displayName)
        resolved.set(contact.mid, contact.displayName)
      }
    }
  }
  return resolved
}

/**
 * Resolve display names for message senders, short-circuiting the
 * authenticated user's own MID from the already-known profile instead of
 * spending a network call on it.
 *
 * @param service - Resumed LineProtocolService.
 * @param mids - Sender MIDs to resolve (duplicates and falsy values ignored).
 * @returns Map of MID to resolved display name (unresolved MIDs are omitted).
 */
export async function resolveSenderNames(
  service: LineProtocolService,
  mids: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(mids.filter(Boolean)))
  const selfMid = service.profile?.mid
  const selfName = service.profile?.displayName
  const remaining: string[] = []
  const resolved = new Map<string, string>()
  for (const mid of unique) {
    if (mid === selfMid && selfName) {
      resolved.set(mid, selfName)
      service.nameCache.set(mid, selfName)
    } else {
      remaining.push(mid)
    }
  }
  const fetched = await resolveUserNames(service, remaining)
  for (const [mid, name] of fetched) {
    resolved.set(mid, name)
  }
  return resolved
}

/**
 * Resolve titles for group/room chat MIDs via getChats' chatName field.
 *
 * @param service - Resumed LineProtocolService.
 * @param chatIds - Group/room chat MIDs to resolve.
 * @returns Map of chat MID to resolved chat title (unresolved MIDs are omitted).
 */
async function resolveGroupNames(
  service: LineProtocolService,
  chatIds: string[],
): Promise<Map<string, string>> {
  const unique = Array.from(new Set(chatIds.filter(Boolean)))
  const resolved = new Map<string, string>()
  const missing: string[] = []
  for (const id of unique) {
    const cached = service.chatCache.get(id)
    if (cached?.chatName) {
      resolved.set(id, cached.chatName)
    } else if (cached === undefined) {
      missing.push(id)
    }
  }
  if (missing.length > 0) {
    const chats = await service.client.getChats(missing, false)
    for (const chat of chats as any[]) {
      if (chat?.chatMid) {
        service.chatCache.set(chat.chatMid, chat)
        if (chat.chatName) {
          resolved.set(chat.chatMid, chat.chatName)
        }
      }
    }
  }
  return resolved
}

/**
 * Resolve a human-readable name for each conversation id, dispatching by
 * LINE's MID prefix convention (u = 1:1 user, c = group, r = room).
 *
 * @param service - Resumed LineProtocolService.
 * @param chatIds - Conversation MIDs, as returned by getMessageBoxes.
 * @returns Map of chat MID to resolved name, or null when unresolvable.
 */
export async function resolveConversationNames(
  service: LineProtocolService,
  chatIds: string[],
): Promise<Map<string, string | null>> {
  const userIds = chatIds.filter((id) => id?.startsWith('u'))
  const groupIds = chatIds.filter(
    (id) => id?.startsWith('c') || id?.startsWith('r'),
  )
  const [userNames, groupNames] = await Promise.all([
    userIds.length > 0
      ? resolveUserNames(service, userIds)
      : Promise.resolve(new Map<string, string>()),
    groupIds.length > 0
      ? resolveGroupNames(service, groupIds)
      : Promise.resolve(new Map<string, string>()),
  ])
  const result = new Map<string, string | null>()
  for (const id of chatIds) {
    result.set(id, userNames.get(id) ?? groupNames.get(id) ?? null)
  }
  return result
}
