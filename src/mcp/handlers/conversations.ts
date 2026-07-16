import { decryptLineMessage } from '../../line/core/message-query-service.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { getExcludedChatIds } from '../../search/scope.js'
import { createCliLogger } from '../../util/log.js'
import { resolveLineMediaDescriptor, resolveLineMediaType } from '../media.js'
import { resolveConversationNames, resolveSenderNames } from '../names.js'
import { createPhiAccumulator, maskInto, phiNote } from '../phi-guard.js'
import { toolError } from './shared.js'

const log = createCliLogger('Yomi')

/**
 * Handle `list_conversations` — list LINE conversations (chats, groups, rooms)
 * with unread counts, a last-message preview, and a resolved display name.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleListConversations(
  service: LineProtocolService,
  args: { limit?: number },
) {
  const result = await service.client.getMessageBoxes({
    lastMessagesPerMessageBoxCount: 1,
    messageBoxCountLimit: args.limit ?? 20,
    withUnreadCount: true,
  })
  const boxes = result.messageBoxes || []
  const names = await resolveConversationNames(
    service,
    boxes.map((box: any) => box.id).filter(Boolean),
  )
  // The last message embedded in getMessageBoxes is E2EE-wrapped for most
  // chats; run it through the same local decrypt path get_chat_messages
  // uses so previews aren't silently empty. No extra network fetch per
  // conversation — decryptLineMessage only resolves already-known/cached
  // E2EE keys, the same cost paid whenever any message from that chat is
  // decrypted.
  const acc = createPhiAccumulator()
  const conversations = await Promise.all(
    boxes.map(async (box: any) => {
      const lastMessage =
        box.lastMessages?.[box.lastMessages.length - 1] || null
      const decryptedLastMessage = lastMessage
        ? await decryptLineMessage(service.e2eeManager, lastMessage, box.id)
        : null
      return {
        id: box.id,
        lastMessagePreview: maskInto(acc, decryptedLastMessage?.text ?? null),
        name: names.get(box.id) ?? null,
        unreadCount: box.unreadCount ?? 0,
      }
    }),
  )
  const content: any[] = [
    { type: 'text' as const, text: JSON.stringify(conversations, null, 2) },
  ]
  const note = phiNote(acc)
  if (note) content.push(note)
  return { content }
}

/**
 * Handle `get_chat_messages` — fetch messages from one conversation,
 * E2EE-decrypted when key material is available, each with a resolved sender
 * name; pages older history with `before`.
 *
 * Without `before`, returns the most recent `count` messages (unchanged
 * behavior). With `before`, fetches exactly one page of messages older
 * than that cursor via getPreviousMessagesV2WithRequest — no pagination
 * loop, no bulk backfill.
 *
 * `mentions` is a deliberately read-only probe: LINE mentions are not in
 * `text` (a plain `@name` there is just text, not a real mention — the
 * actual mention data lives in `contentMetadata.MENTION`, already parsed
 * per-message by parsers.ts). Nobody has verified MENTION's shape against
 * a real payload, so it is passed through raw and unparsed rather than
 * guessed at. This is the spec-gathering step; do not "finish" mentions by
 * inventing a parsed shape or an outbound (send-a-mention) implementation
 * from this alone — wait for an operator to observe the real payload
 * against a live mentioning message first.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleGetChatMessages(
  service: LineProtocolService,
  args: {
    chatId: string
    count?: number
    before?: { messageId?: string; deliveredTime?: number }
  },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  const fetched = args.before
    ? await service.getPreviousMessages(
        args.chatId,
        args.count ?? 50,
        args.before,
      )
    : await service.getRecentMessages(args.chatId, args.count ?? 50)
  // LINE's getPreviousMessagesV2 treats endMessageId as INCLUSIVE, so the
  // cursor message reappears at the top of each older page. Drop it so
  // `before` returns strictly-older messages and callers can page without
  // dedup.
  const messages = args.before?.messageId
    ? fetched.filter(
        (message: any) => String(message.id) !== String(args.before?.messageId),
      )
    : fetched
  const names = await resolveSenderNames(
    service,
    messages.map((message: any) => message.from).filter(Boolean),
  )
  const acc = createPhiAccumulator()
  const shaped = messages.map((message: any) => ({
    createdTime: message.createdTime,
    deliveredTime: message.deliveredTime,
    from: message.from,
    fromName: names.get(message.from) ?? null,
    id: message.id,
    mediaType:
      resolveLineMediaDescriptor(message) !== null
        ? resolveLineMediaType(Number(message.contentType))
        : null,
    // Read-only probe (see JSDoc above `handleGetChatMessages`): raw,
    // unparsed passthrough of contentMetadata.MENTION. Do not parse this
    // into a structured shape here — its real format is unknown and must
    // be observed against a live mentioning message before anyone builds
    // the outbound (send-a-mention) side.
    mentions: message.contentMetadata?.MENTION ?? null,
    text: maskInto(acc, message.text),
    e2eeDecrypted: message.e2eeDecrypted ?? null,
    // Emitted ONLY when the message decrypted but could not be authenticated
    // (LINE E2EE v1 — AES-CBC, no tag, no AAD), so its presence is a signal
    // rather than noise on the ~98% of traffic that is v2 and verified.
    ...(message.e2eeDecrypted && message.e2eeIntegrityVerified === false
      ? { e2eeIntegrityVerified: false }
      : {}),
  }))
  const content: any[] = [
    { type: 'text' as const, text: JSON.stringify(shaped, null, 2) },
  ]
  const note = phiNote(acc)
  if (note) content.push(note)
  return { content }
}

/**
 * Handle `mark_read` — explicitly send a LINE read receipt (sendChatChecked)
 * for one conversation. This is the user-intent path; background capture and
 * get_unread_digest never mark read. When messageId is omitted, marks read up
 * to the latest message. Honest failure if nothing can be marked.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleMarkRead(
  service: LineProtocolService,
  args: { chatId: string; messageId?: string },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  const result = await service.markChatRead(args.chatId, args.messageId)
  log.info('mark_read.done', { chatId: args.chatId, marked: result.marked })
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  }
}

/**
 * Handle `get_unread_digest` — one-shot composite: every conversation with
 * unread messages, each with its most recent messages, so a caller can
 * summarize/triage in a single call instead of list_conversations + N
 * get_chat_messages. Purely read-only: it never marks anything read and never
 * touches the local search index. Denylist-excluded chats are omitted. No
 * unread → empty list (honest, not fabricated).
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleGetUnreadDigest(
  service: LineProtocolService,
  args: { perChat?: number; limit?: number },
) {
  const result = await service.client.getMessageBoxes({
    lastMessagesPerMessageBoxCount: 1,
    messageBoxCountLimit: args.limit ?? 20,
    withUnreadCount: true,
  })
  const excluded = getExcludedChatIds()
  const unreadBoxes = (result.messageBoxes || []).filter(
    (box: any) => (box.unreadCount ?? 0) > 0 && box.id && !excluded.has(box.id),
  )
  const names = await resolveConversationNames(
    service,
    unreadBoxes.map((box: any) => box.id),
  )
  const perChat = args.perChat ?? 10
  const acc = createPhiAccumulator()
  const digest = await Promise.all(
    unreadBoxes.map(async (box: any) => {
      const messages = await service.getRecentMessages(box.id, perChat)
      const senderNames = await resolveSenderNames(
        service,
        messages.map((m: any) => m.from).filter(Boolean),
      )
      return {
        chatId: box.id,
        name: names.get(box.id) ?? null,
        unreadCount: box.unreadCount ?? 0,
        messages: messages.map((m: any) => ({
          createdTime: m.createdTime,
          from: m.from,
          fromName: senderNames.get(m.from) ?? null,
          id: m.id,
          mediaType:
            resolveLineMediaDescriptor(m) !== null
              ? resolveLineMediaType(Number(m.contentType))
              : null,
          text: maskInto(acc, m.text),
        })),
      }
    }),
  )
  const content: any[] = [
    { type: 'text' as const, text: JSON.stringify(digest, null, 2) },
  ]
  const note = phiNote(acc)
  if (note) content.push(note)
  return { content }
}
