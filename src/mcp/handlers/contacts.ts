import type { LineProtocolService } from '../../line/core/service.js'
import { resolveUserNames } from '../names.js'
import { toolError } from './shared.js'

/** One resolved LINE contact/member shape shared by the contact/group tools. */
interface ContactSummary {
  mid: string
  displayName: string | null
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
    if (contact.displayName) {
      service.nameCache.set(contact.mid, contact.displayName)
    }
    summaries.push({
      mid: contact.mid,
      displayName: contact.displayName ?? null,
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
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(contacts, null, 2) },
    ],
  }
}

/**
 * Handle `find_contact` — case-insensitive substring match over the
 * friend list's displayName, so a caller can resolve a person's name to
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
  const matches = contacts.filter((contact) =>
    contact.displayName?.toLowerCase().includes(needle),
  )
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(matches, null, 2) },
    ],
  }
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
    return toolError('chatId is required.')
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
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify(summaries, null, 2) },
    ],
  }
}
