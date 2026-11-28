import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'
import { contactDisplayName, resolveUserNames } from '../names.js'
import { jsonResult, toolError, toonResult } from './shared.js'

const log = createCliLogger('Yomi')

/** One resolved LINE contact/member shape shared by the contact/group tools. */
interface ContactSummary {
  mid: string
  /** Name as shown in the user's LINE app (user-set name when present). */
  displayName: string | null
  /** The friend's own profile name; only present when the user renamed them. */
  profileName?: string | null
}

/**
 * Fetch and normalize the authenticated user's full friend list in one
 * round trip: enumerate friend MIDs, then resolve them all through a
 * single batched getContacts call. Also warms the shared nameCache so
 * later tool calls (get_chat_messages, list_conversations) skip the
 * network for these MIDs.
 *
 * @param service - Resumed LineProtocolService.
 * @returns Normalized friend contacts (unresolved names surfaced as null, never fabricated).
 */
async function fetchAllContacts(
  service: LineProtocolService,
): Promise<ContactSummary[]> {
  const mids = await service.client.getAllContactIds()
  if (!Array.isArray(mids) || mids.length === 0) {
    return []
  }
  const contacts = await service.client.getContacts(mids)
  const summaries: ContactSummary[] = []
  for (const contact of contacts as any[]) {
    if (!contact?.mid) {
      continue
    }
    const name = contactDisplayName(contact)
    if (name) {
      service.nameCache.set(contact.mid, name)
    }
    summaries.push({
      mid: contact.mid,
      displayName: name,
      ...(contact.displayNameOverridden && contact.displayName
        ? { profileName: contact.displayName }
        : {}),
    })
  }
  return summaries
}

/**
 * Handle `list_contacts` — the raw LINE friend list, straight from
 * getAllContactIds + getContacts. No ranking, no scoring: whatever order
 * LINE returns is what callers get.
 *
 * @param service - Resumed LineProtocolService.
 * @returns MCP tool result.
 */
export async function handleListContacts(service: LineProtocolService) {
  const contacts = await fetchAllContacts(service)
  return toonResult(contacts)
}

/**
 * Handle `find_contact` — case-insensitive substring match over the
 * friend list's displayName (and profileName, when the user renamed the
 * friend), so a caller can resolve a person's name to
 * the MID `send_message` needs for a 1:1. Pure lookup: no fuzzy scoring,
 * no ranking by interaction history.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleFindContact(
  service: LineProtocolService,
  args: { name: string },
) {
  if (!args.name) {
    return toolError('name is required.')
  }
  const needle = args.name.toLowerCase()
  const contacts = await fetchAllContacts(service)
  const matches = contacts.filter(
    (contact) =>
      contact.displayName?.toLowerCase().includes(needle) ||
      contact.profileName?.toLowerCase().includes(needle),
  )
  return toonResult(matches)
}

/**
 * Handle `get_group_members` — the raw member list of one LINE group/room.
 *
 * Members come from getChats(withMembers): the chat's `extra` union carries
 * the group-chat record at field 1, whose field 4 is a
 * `{ memberMid: joinTimestamp }` map and field 5 the pending-invitation map.
 * MIDs are resolved to display names via the shared batched/cached resolver.
 * (getGroup returns null for these chats and is not used.)
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleGetGroupMembers(
  service: LineProtocolService,
  args: { chatId: string },
) {
  if (!args.chatId) {
    return toolError('chat_id is required.')
  }
  const chats = await service.client.getChats([args.chatId], true)
  const chat = Array.isArray(chats) ? chats[0] : chats
  const groupExtra = (chat as any)?.extra?.['1']
  if (!groupExtra) {
    return toolError(
      `No membership data for chatId "${args.chatId}" (not a group chat, or LINE returned no member list).`,
    )
  }
  const memberMids = Object.keys(groupExtra['4'] ?? {})
  const invitedMids = Object.keys(groupExtra['5'] ?? {})
  const names = await resolveUserNames(service, [...memberMids, ...invitedMids])
  const summaries = [
    ...memberMids.map((mid) => ({
      mid,
      displayName: names.get(mid) ?? null,
      invited: false,
    })),
    ...invitedMids.map((mid) => ({
      mid,
      displayName: names.get(mid) ?? null,
      invited: true,
    })),
  ]
  return toonResult(summaries)
}

/**
 * Handle `add_friend` — REALLY adds a person to THIS account's LINE friends now
 * by MID (TalkService findAndAddContactsByMid).
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleAddFriend(
  service: LineProtocolService,
  args: { mid: string },
) {
  if (!args.mid) {
    return toolError('mid is required.')
  }
  const result = await service.addFriend(args.mid)
  log.info('add_friend.done', { mid: args.mid })
  return jsonResult(result)
}

/**
 * Validate an identifier value for a contact lookup or add call.
 *
 * @param by - Identifier type.
 * @param value - Caller-supplied value.
 * @returns An error string, or null when valid.
 */
function validateIdentifier(
  by: string | undefined,
  value: unknown,
): string | null {
  if (!by) {
    return 'by is required (userid, phone, ticket, or mid).'
  }
  if (by === 'phone') {
    if (
      !Array.isArray(value) ||
      value.length === 0 ||
      !value.every((item) => typeof item === 'string' && item.trim())
    ) {
      return 'phone requires a non-empty array of phone numbers.'
    }
    return null
  }
  if (typeof value !== 'string' || !value.trim()) {
    return `${by} requires a non-empty string.`
  }
  return null
}

/**
 * Normalize one or more service contacts into the MCP contact summary shape.
 *
 * @param service - Resumed LineProtocolService.
 * @param result - Normalized contact or list of contacts.
 * @returns Contact summaries with unresolved names left as null.
 */
function contactSummaries(
  service: LineProtocolService,
  result: any,
): ContactSummary[] {
  const items = Array.isArray(result) ? result : [result]
  const summaries: ContactSummary[] = []
  for (const contact of items as any[]) {
    if (!contact?.mid) {
      continue
    }
    const name = contactDisplayName(contact)
    if (name) {
      service.nameCache.set(contact.mid, name)
    }
    summaries.push({
      mid: contact.mid,
      displayName: name,
      ...(contact.displayNameOverridden && contact.displayName
        ? { profileName: contact.displayName }
        : {}),
    })
  }
  return summaries
}

/**
 * Handle `search_contact` — pure read-only lookup by LINE ID, phone number,
 * or invite ticket. No findAndAdd* endpoint is reachable from this handler.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleSearchContact(
  service: LineProtocolService,
  args: { by?: string; value?: unknown },
) {
  const by = args?.by
  if (by && !['userid', 'phone', 'ticket'].includes(by)) {
    return toolError(
      `search_contact does not support "${by}". Use userid, phone, or ticket.`,
    )
  }
  const error = validateIdentifier(by, args?.value)
  if (error) {
    return toolError(error)
  }
  const result = await service.searchContacts({
    by: by as 'userid' | 'phone' | 'ticket',
    value: args.value as string | string[],
  })
  return toonResult(contactSummaries(service, result))
}

/**
 * Handle `add_contact` — explicitly adds friends by MID, LINE ID, or phone.
 * Kept separate from search_contact so the side effect is visible in the tool
 * name instead of being hidden behind a lookup.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleAddContact(
  service: LineProtocolService,
  args: { by?: string; value?: unknown; reference?: string },
) {
  const by = args?.by
  if (by && !['mid', 'userid', 'phone'].includes(by)) {
    return toolError(
      `add_contact does not support "${by}". Use mid, userid, or phone.`,
    )
  }
  const error = validateIdentifier(by, args?.value)
  if (error) {
    return toolError(error)
  }
  const result = await service.addContact({
    by: by as 'mid' | 'userid' | 'phone',
    value: args.value as string | string[],
    ...(args.reference ? { reference: args.reference } : {}),
  })
  return toonResult(contactSummaries(service, result))
}

/**
 * Handle `block_contact` — REALLY blocks a contact for THIS account now
 * (TalkService blockContact). Reversible with unblock_contact.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleBlockContact(
  service: LineProtocolService,
  args: { mid: string },
) {
  if (!args.mid) {
    return toolError('mid is required.')
  }
  const result = await service.blockContact(args.mid)
  log.info('block_contact.done', { mid: args.mid })
  return jsonResult(result)
}

/**
 * Handle `unblock_contact` — REALLY unblocks a previously blocked contact for
 * THIS account now (TalkService unblockContact).
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleUnblockContact(
  service: LineProtocolService,
  args: { mid: string },
) {
  if (!args.mid) {
    return toolError('mid is required.')
  }
  const result = await service.unblockContact(args.mid)
  log.info('unblock_contact.done', { mid: args.mid })
  return jsonResult(result)
}
