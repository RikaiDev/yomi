import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'
import { jsonResult, toolError } from './shared.js'

const log = createCliLogger('Yomi')

/**
 * Handle `rename_group` — REALLY renames a real LINE group/chat now
 * (TalkService updateChat). Visible to every member. One call, one rename.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleRenameGroup(
  service: LineProtocolService,
  args: { chatId: string; name: string },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  if (!args.name) {
    return toolError('name is required.')
  }
  const result = await service.renameGroup(args.chatId, args.name)
  log.info('rename_group.done', { chatId: args.chatId })
  return jsonResult(result)
}

/**
 * Handle `invite_member` — REALLY invites members into a real LINE group now
 * (TalkService inviteIntoChat). Invitees must accept before joining a group.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleInviteMember(
  service: LineProtocolService,
  args: { chatId: string; mids: string[] },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  if (!Array.isArray(args.mids) || args.mids.length === 0) {
    return toolError('mids must be a non-empty array of member MIDs.')
  }
  const result = await service.inviteToGroup(args.chatId, args.mids)
  log.info('invite_member.done', {
    chatId: args.chatId,
    count: args.mids.length,
  })
  return jsonResult(result)
}

/**
 * Handle `kick_member` — REALLY removes members from a real LINE group now
 * (TalkService deleteOtherFromChat). The removed members lose access
 * immediately; visible to every member. Irreversible without re-inviting.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleKickMember(
  service: LineProtocolService,
  args: { chatId: string; mids: string[] },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  if (!Array.isArray(args.mids) || args.mids.length === 0) {
    return toolError('mids must be a non-empty array of member MIDs.')
  }
  const result = await service.kickFromGroup(args.chatId, args.mids)
  log.info('kick_member.done', {
    chatId: args.chatId,
    count: args.mids.length,
  })
  return jsonResult(result)
}

/**
 * Handle `leave_group` — REALLY makes THIS account leave a real LINE group now
 * (TalkService deleteSelfFromChat). The account loses access to the group.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleLeaveGroup(
  service: LineProtocolService,
  args: { chatId: string },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  const result = await service.leaveGroup(args.chatId)
  log.info('leave_group.done', { chatId: args.chatId })
  return jsonResult(result)
}

/**
 * Handle `create_group` — REALLY creates a new LINE group/room now with the
 * given members (TalkService createChat). `chatType` 0 = group (invitees must
 * accept), 1 = room (members added directly); defaults to 1.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleCreateGroup(
  service: LineProtocolService,
  args: { name: string; mids: string[]; chatType?: number },
) {
  if (!args.name) {
    return toolError('name is required.')
  }
  if (!Array.isArray(args.mids) || args.mids.length === 0) {
    return toolError('mids must be a non-empty array of member MIDs.')
  }
  const result = await service.createGroup(args.name, args.mids, args.chatType)
  log.info('create_group.done', {
    name: args.name,
    count: args.mids.length,
    chatId: result?.chatId ?? null,
  })
  return jsonResult(result)
}

/**
 * Handle `accept_invitation` — REALLY accepts a group/chat invitation for THIS
 * account now (TalkService acceptChatInvitation); the account joins the chat.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleAcceptInvitation(
  service: LineProtocolService,
  args: { chatId: string },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  const result = await service.acceptInvitation(args.chatId)
  log.info('accept_invitation.done', { chatId: args.chatId })
  return jsonResult(result)
}
