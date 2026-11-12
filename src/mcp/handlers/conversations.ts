import { isSquareChatMid } from '../../line/client/square-service/client.js'
import { CONTENT_TYPE } from '../../line/core/constants.js'
import { listBoxesByRecency } from '../../line/core/message-box-recency.js'
import { sanitizeMessagePreview } from '../../line/core/message-preview.js'
import { decryptLineMessage } from '../../line/core/message-query-service.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { getExcludedChatIds } from '../../search/scope.js'
import { createCliLogger } from '../../util/log.js'
import { resolveLineMediaDescriptor, resolveLineMediaType } from '../media.js'
import { resolveConversationNames, resolveSenderNames } from '../names.js'
import { createPhiAccumulator, maskInto, phiNote } from '../phi-guard.js'
import { jsonResult, toolError, toonText } from './shared.js'

const log = createCliLogger('Yomi')

function messageTimestamp(message: any): number {
  return Number(message?.deliveredTime || message?.createdTime || 0)
}

function latestMessage(messages: any[] | undefined): any | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  return messages.reduce((latest, candidate) =>
    messageTimestamp(candidate) >= messageTimestamp(latest)
      ? candidate
      : latest,
  )
}

function contentTypeToLabel(contentType: number): string {
  const map: Record<number, string> = {
    [CONTENT_TYPE.NONE]: 'none',
    [CONTENT_TYPE.IMAGE]: 'image',
    [CONTENT_TYPE.VIDEO]: 'video',
    [CONTENT_TYPE.AUDIO]: 'audio',
    [CONTENT_TYPE.HTML]: 'html',
    [CONTENT_TYPE.PDF]: 'pdf',
    [CONTENT_TYPE.CALL]: 'call',
    [CONTENT_TYPE.STICKER]: 'sticker',
    [CONTENT_TYPE.PRESENCE]: 'presence',
    [CONTENT_TYPE.GIFT]: 'gift',
    [CONTENT_TYPE.GROUPBOARD]: 'groupboard',
    [CONTENT_TYPE.APPLINK]: 'applink',
    [CONTENT_TYPE.LINK]: 'link',
    [CONTENT_TYPE.CONTACT]: 'contact',
    [CONTENT_TYPE.FILE]: 'file',
    [CONTENT_TYPE.LOCATION]: 'location',
    [CONTENT_TYPE.POSTNOTIFICATION]: 'postnotification',
    [CONTENT_TYPE.RICH]: 'rich',
    [CONTENT_TYPE.CHATEVENT]: 'chatevent',
    [CONTENT_TYPE.MUSIC]: 'music',
    [CONTENT_TYPE.PAYMENT]: 'payment',
    [CONTENT_TYPE.EXTIMAGE]: 'extimage',
    [CONTENT_TYPE.FLEX]: 'flex',
  }
  return map[contentType] ?? `unknown_${contentType}`
}

function classifySourceType(
  chatId: string,
  senderMid: string | null,
  senderName: string | null,
  isSelf: boolean,
): 'user' | 'official' | 'bot' | 'system' {
  if (isSelf) return 'user'
  if (!senderMid) return 'system'
  if (senderMid.startsWith('u') && senderName?.includes('官方'))
    return 'official'
  if (senderMid.startsWith('u') && senderName?.includes('Bot')) return 'bot'
  return 'user'
}

function extractStickerInfo(message: any): {
  stickerId: string | null
  packageId: string | null
} {
  const meta = message?.contentMetadata || {}
  if (meta.STKID && meta.STKPKGID) {
    return { stickerId: String(meta.STKID), packageId: String(meta.STKPKGID) }
  }
  return { stickerId: null, packageId: null }
}

function extractReplyTo(message: any): string | null {
  const meta = message?.contentMetadata || {}
  // RELATED_MESSAGE_ID or similar fields for replies
  return meta.RELATED_MESSAGE_ID ? String(meta.RELATED_MESSAGE_ID) : null
}

function extractMentions(
  message: any,
): Array<{ mid: string; start: number; end: number; name?: string }> | null {
  const raw = message?.contentMetadata?.MENTION
  if (!raw) return null
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const mentionList = parsed?.MENTIONEES ?? parsed?.MENTIONS ?? []
    return mentionList
      .map((m: any) => ({
        mid: String(m?.M ?? m?.mid ?? ''),
        start: Number(m?.S ?? m?.start ?? 0),
        end: Number(m?.E ?? m?.end ?? 0),
        name: m?.D ?? m?.name ?? undefined,
      }))
      .filter((m) => m.mid)
  } catch {
    return null
  }
}

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
  try {
    await service.client.syncLongPoll(50, 1000)
    if (service.sessionState?.saveSyncRevisions) {
      await service.sessionState.saveSyncRevisions(
        Number(service.client.revision || 0),
        Number(service.client.globalRevision || 0),
        Number(service.client.individualRevision || 0),
      )
    }
  } catch {}
  const boxes = (
    await listBoxesByRecency(service, { withUnreadCount: true })
  ).slice(0, args.limit ?? 20)
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
      let lastMessage = latestMessage(box.lastMessages)
      const cursorTime = Number(box.lastDeliveredMessageId?.deliveredTime || 0)
      if (
        box.id &&
        (!lastMessage || messageTimestamp(lastMessage) < cursorTime)
      ) {
        try {
          const recent = await service.getRecentMessages(box.id, 1)
          const candidate = latestMessage(recent)
          if (
            candidate &&
            messageTimestamp(candidate) >= messageTimestamp(lastMessage)
          ) {
            lastMessage = candidate
          }
        } catch {}
      }
      const decryptedLastMessage = lastMessage
        ? await decryptLineMessage(service.e2eeManager, lastMessage, box.id)
        : null
      const previewText = sanitizeMessagePreview(
        decryptedLastMessage?.text ?? lastMessage?.text,
      )
      return {
        id: box.id,
        lastMessagePreview: maskInto(
          acc,
          previewText || (lastMessage?.text ? '[加密訊息]' : null),
        ),
        name: names.get(box.id) ?? null,
        unreadCount: box.unreadCount ?? 0,
      }
    }),
  )
  try {
    const squareChats = await service.client.getJoinedSquareChats(
      args.limit ?? 20,
    )
    for (const chat of squareChats) {
      let last = chat.lastMessage
      let senderName = chat.lastSenderName
      if (!last) {
        const recent = await service.client.getSquareChatMessages(chat.id, 1)
        const normalized = recent.at(-1)
        if (normalized) {
          last = {
            4: normalized.id,
            5: normalized.createdTime,
            10: normalized.text,
            15: normalized.contentType,
          }
          senderName = normalized.fromName
        }
      }
      const preview = sanitizeMessagePreview(last?.[10])
      conversations.push({
        id: chat.id,
        lastMessagePreview: maskInto(
          acc,
          preview || (last ? '[社群訊息]' : null),
        ),
        name: maskInto(acc, chat.name),
        unreadCount: chat.unreadCount,
        ...(senderName ? { lastSenderName: maskInto(acc, senderName) } : {}),
      })
    }
  } catch {
    // OpenChat availability differs by LINE account/region. TalkService
    // conversations remain authoritative when SquareService is unavailable.
  }
  const content: any[] = [
    { type: 'text' as const, text: toonText(conversations) },
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
  if (isSquareChatMid(args.chatId)) {
    const squareMessages = await service.client.getSquareChatMessages(
      args.chatId,
      args.count ?? 50,
    )
    const acc = createPhiAccumulator()
    const shaped = squareMessages.map((message: any) => {
      const contentTypeNum = Number(message.contentType)
      const contentTypeLabel = contentTypeToLabel(contentTypeNum)
      const stickerInfo = extractStickerInfo(message)
      const replyTo = extractReplyTo(message)
      const mentions = extractMentions(message)
      return {
        createdTime: message.createdTime,
        deliveredTime: message.createdTime,
        from: message.fromMid,
        fromName: maskInto(acc, message.fromName),
        id: message.id,
        contentType: contentTypeNum,
        contentTypeLabel,
        mediaType: resolveLineMediaType(contentTypeNum),
        mentions,
        text: maskInto(
          acc,
          sanitizeMessagePreview(message.text) || '[社群訊息]',
        ),
        e2eeDecrypted: null,
        isSelf: false,
        sourceType: 'user',
        stickerId: stickerInfo.stickerId,
        packageId: stickerInfo.packageId,
        replyToMessageId: replyTo,
        service: 'SQUARE',
      }
    })
    const content: any[] = [{ type: 'text' as const, text: toonText(shaped) }]
    const note = phiNote(acc)
    if (note) content.push(note)
    return { content }
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
  const myMid = service.profile?.mid
  const acc = createPhiAccumulator()
  const shaped = messages.map((message: any) => {
    const contentTypeNum = Number(message.contentType ?? 0)
    const contentTypeLabel = contentTypeToLabel(contentTypeNum)
    const isSelf = message.from === myMid
    const senderName = names.get(message.from) ?? null
    const sourceType = classifySourceType(
      args.chatId,
      message.from,
      senderName,
      isSelf,
    )
    const stickerInfo = extractStickerInfo(message)
    const replyTo = extractReplyTo(message)
    const mentions = extractMentions(message)
    const hasMedia = resolveLineMediaDescriptor(message) !== null
    return {
      createdTime: message.createdTime,
      deliveredTime: message.deliveredTime,
      from: message.from,
      fromName: maskInto(acc, senderName),
      id: message.id,
      contentType: contentTypeNum,
      contentTypeLabel,
      mediaType: hasMedia ? resolveLineMediaType(contentTypeNum) : null,
      mentions,
      text: maskInto(
        acc,
        sanitizeMessagePreview(message.text) ||
          (message.text ? '[加密訊息]' : null),
      ),
      e2eeDecrypted: message.e2eeDecrypted ?? null,
      isSelf,
      sourceType,
      stickerId: stickerInfo.stickerId,
      packageId: stickerInfo.packageId,
      replyToMessageId: replyTo,
      // Emitted ONLY when the message decrypted but could not be authenticated
      // (LINE E2EE v1 — AES-CBC, no tag, no AAD), so its presence is a signal
      // rather than noise on the ~98% of traffic that is v2 and verified.
      ...(message.e2eeDecrypted && message.e2eeIntegrityVerified === false
        ? { e2eeIntegrityVerified: false }
        : {}),
    }
  })
  const content: any[] = [{ type: 'text' as const, text: toonText(shaped) }]
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
  return jsonResult(result)
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
  const excluded = getExcludedChatIds()
  const allUnread = (
    await listBoxesByRecency(service, { withUnreadCount: true })
  ).filter(
    (box: any) => (box.unreadCount ?? 0) > 0 && box.id && !excluded.has(box.id),
  )
  const unreadBoxes =
    args.limit && args.limit > 0 ? allUnread.slice(0, args.limit) : allUnread
  const names = await resolveConversationNames(
    service,
    unreadBoxes.map((box: any) => box.id),
  )
  const perChat = args.perChat ?? 10
  const myMid = service.profile?.mid
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
        messages: messages.map((m: any) => {
          const contentTypeNum = Number(m.contentType ?? 0)
          const contentTypeLabel = contentTypeToLabel(contentTypeNum)
          const isSelf = m.from === myMid
          const senderName = senderNames.get(m.from) ?? null
          const sourceType = classifySourceType(
            box.id,
            m.from,
            senderName,
            isSelf,
          )
          const stickerInfo = extractStickerInfo(m)
          const replyTo = extractReplyTo(m)
          const mentions = extractMentions(m)
          const hasMedia = resolveLineMediaDescriptor(m) !== null
          return {
            createdTime: m.createdTime,
            deliveredTime: m.deliveredTime,
            from: m.from,
            fromName: maskInto(acc, senderName),
            id: m.id,
            contentType: contentTypeNum,
            contentTypeLabel,
            mediaType: hasMedia ? resolveLineMediaType(contentTypeNum) : null,
            mentions,
            text: maskInto(
              acc,
              sanitizeMessagePreview(m.text) || (m.text ? '[加密訊息]' : null),
            ),
            e2eeDecrypted: m.e2eeDecrypted ?? null,
            isSelf,
            sourceType,
            stickerId: stickerInfo.stickerId,
            packageId: stickerInfo.packageId,
            replyToMessageId: replyTo,
          }
        }),
      }
    }),
  )
  const content: any[] = [{ type: 'text' as const, text: toonText(digest) }]
  if (unreadBoxes.length < allUnread.length) {
    content.push({
      type: 'text' as const,
      text: `Showing the ${unreadBoxes.length} most recently active of ${allUnread.length} unread conversations (limit=${args.limit}). Omit limit to list all.`,
    })
  }
  const note = phiNote(acc)
  if (note) content.push(note)
  return { content }
}
