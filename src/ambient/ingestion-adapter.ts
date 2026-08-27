import { sanitizeMessagePreview } from '../line/core/message-preview.js'
import type { LineProtocolService } from '../line/core/service.js'
import { resolveConversationNames, resolveSenderNames } from '../mcp/names.js'
import { computeEventId } from './journal/crypto.js'
import type { LineActivityEvent, LineContentType } from './journal/types.js'

export interface IngestionOptions {
  windowStart: number
  maxLookbackMs?: number
  maxChats?: number
  maxMessagesPerChat?: number
}

function timestamp(message: any): number {
  return Number(message?.deliveredTime || message?.createdTime || 0)
}

function mediaType(contentType: number): LineContentType {
  const map: Record<number, LineContentType> = {
    1: 'image',
    2: 'video',
    3: 'audio',
    7: 'sticker',
    14: 'file',
  }
  return map[contentType] ?? 'text'
}

function mentionMids(metadata: any): string[] {
  try {
    const value =
      typeof metadata?.MENTION === 'string'
        ? JSON.parse(metadata.MENTION)
        : metadata?.MENTION
    const mentions = value?.MENTIONEES ?? value?.MENTIONS ?? []
    return mentions
      .map((item: any) => item?.M ?? item?.mid)
      .filter((mid: unknown): mid is string => typeof mid === 'string')
  } catch {
    return []
  }
}

export interface IngestionResult {
  events: LineActivityEvent[]
  chatNames: Map<string, string>
  coverageLimited: boolean
  chatsScanned: number
  messagesScanned: number
  officialChatsSkipped: number
}

export class LineIngestionAdapter {
  constructor(private readonly service: LineProtocolService) {}

  async collectRecentEvents(
    options: IngestionOptions,
  ): Promise<IngestionResult> {
    const windowStart = options.windowStart
    const maxChats = options.maxChats ?? 40
    const maxMessagesPerChat = options.maxMessagesPerChat ?? 100

    const boxesResult = await this.service.client.getAllMessageBoxes({
      messageBoxCountLimit: 200,
      lastMessagesPerMessageBoxCount: 1,
      withUnreadCount: false,
    })

    const boxes = (boxesResult.messageBoxes ?? [])
      .filter((box: any) => {
        const last = box.lastMessages?.[0]
        return (
          Number(
            last?.deliveredTime ||
              box.lastDeliveredMessageId?.deliveredTime ||
              0,
          ) >= windowStart
        )
      })
      .slice(0, 80)

    if ((boxesResult.messageBoxes ?? []).length === 0) {
      throw new Error('LINE returned no message boxes for ambient observation')
    }

    const chatIds = boxes.map((box: any) => String(box.id)).filter(Boolean)
    const resolvedChatNames = await resolveConversationNames(
      this.service,
      chatIds,
    )
    const chatNames = new Map(
      [...resolvedChatNames].map(([id, name]) => [id, name ?? 'LINE 對話']),
    )

    const events: LineActivityEvent[] = []
    const officialChatIds = new Set<string>()
    const userChatIds = chatIds.filter((id) => id.startsWith('u'))

    if (userChatIds.length > 0) {
      try {
        const contacts = await this.service.client.getContacts(userChatIds)
        for (const contact of contacts ?? []) {
          if (contact?.mid && contact?.isOfficial) {
            officialChatIds.add(String(contact.mid))
          }
        }
      } catch {}
    }

    const observableChatIds = chatIds
      .filter((chatId) => !officialChatIds.has(chatId))
      .slice(0, maxChats)

    let coverageLimited = false

    for (const chatId of observableChatIds) {
      const recent = await this.service.getRecentMessages(
        chatId,
        maxMessagesPerChat,
      )
      if (
        recent.length >= maxMessagesPerChat &&
        Math.min(...recent.map((message: any) => timestamp(message))) >
          windowStart
      ) {
        coverageLimited = true
      }
      const messages = recent.filter(
        (message: any) => timestamp(message) >= windowStart,
      )
      const mids = [
        ...new Set(
          messages
            .flatMap((message: any) => [
              message.from,
              ...mentionMids(message.contentMetadata),
            ])
            .filter(Boolean),
        ),
      ] as string[]
      const names = await resolveSenderNames(this.service, mids)

      for (const message of messages) {
        const type = mediaType(Number(message.contentType ?? 0))
        const text = sanitizeMessagePreview(message.text) || null
        const mNames = mentionMids(message.contentMetadata)
          .map((mid) => names.get(mid))
          .filter((name): name is string => Boolean(name))
        const isSelf = message.from === this.service.profile?.mid
        const mentionsSelf = mentionMids(message.contentMetadata).includes(
          String(this.service.profile?.mid ?? ''),
        )
        const msgId = String(message.id)

        events.push({
          eventId: computeEventId(chatId, msgId),
          chatId,
          messageId: msgId,
          opRevision: message.opRevision ? Number(message.opRevision) : null,
          senderMid: message.from ? String(message.from) : null,
          senderName: names.get(message.from) ?? null,
          sentAt: timestamp(message),
          contentType: type,
          text,
          metadata: {
            mentionNames: mNames,
            mentionMids: mentionMids(message.contentMetadata),
            fileName: message.fileName ? String(message.fileName) : undefined,
            stickerId:
              type === 'sticker' && message.contentMetadata?.STKID
                ? String(message.contentMetadata.STKID)
                : undefined,
            sourceUrl:
              type === 'sticker' && message.contentMetadata?.STKID
                ? `https://stickershop.line-scdn.net/stickershop/v1/sticker/${message.contentMetadata.STKID}/android/sticker.png`
                : null,
          },
          isSelf,
          mentionsSelf,
          ocrEligible: true,
        })
      }
    }

    try {
      const joinedSquareChats =
        await this.service.client.getJoinedSquareChats(40)
      const hydratedSquareChats = await Promise.all(
        joinedSquareChats.map(async (chat: any) => {
          if (chat.lastMessage) return chat
          try {
            const status = await this.service.client.getSquareChatStatus(
              chat.id,
            )
            return { ...chat, lastMessage: status?.[3]?.[1] ?? null }
          } catch {
            return chat
          }
        }),
      )
      const activeSquareChats = hydratedSquareChats.filter((chat: any) => {
        const last = chat.lastMessage
        return Number(last?.[6] || last?.[5] || 0) >= windowStart
      })
      if (activeSquareChats.length > 20) coverageLimited = true

      for (const chat of activeSquareChats.slice(0, 20)) {
        const recent = await this.service.client.getSquareChatMessages(
          chat.id,
          maxMessagesPerChat,
        )
        if (
          recent.length >= maxMessagesPerChat &&
          Math.min(
            ...recent.map((message: any) => Number(message.createdTime ?? 0)),
          ) > windowStart
        ) {
          coverageLimited = true
        }
        const messages = recent.filter(
          (message: any) => Number(message.createdTime ?? 0) >= windowStart,
        )
        chatNames.set(chat.id, chat.name ?? 'LINE 社群')

        const senderNames = new Map<string, string>(
          messages
            .filter((m) => m?.fromMid && m?.fromName)
            .map((m) => [String(m.fromMid), String(m.fromName)]),
        )

        for (const message of messages) {
          const type = mediaType(Number(message.contentType ?? 0))
          const mentions = mentionMids(message.contentMetadata)
          const msgId = String(message.id)

          events.push({
            eventId: computeEventId(chat.id, msgId),
            chatId: chat.id,
            messageId: msgId,
            opRevision: null,
            senderMid: message.fromMid ? String(message.fromMid) : null,
            senderName: message.fromName ? String(message.fromName) : null,
            sentAt: Number(message.createdTime ?? 0),
            contentType: type,
            text: sanitizeMessagePreview(message.text) || null,
            metadata: {
              fileName: message.fileName ? String(message.fileName) : undefined,
              mentionMids: mentions,
              mentionNames: mentions
                .map((mid) => senderNames.get(mid))
                .filter((name): name is string => Boolean(name)),
              sourceUrl:
                type === 'sticker' && message.contentMetadata?.STKID
                  ? `https://stickershop.line-scdn.net/stickershop/v1/sticker/${message.contentMetadata.STKID}/android/sticker.png`
                  : null,
            },
            isSelf: message.isSelf === true,
            mentionsSelf: Boolean(
              chat.memberMid && mentions.includes(String(chat.memberMid)),
            ),
            ocrEligible: true,
          })
        }
      }
    } catch {
      // SquareService discovery is optional.
    }

    return {
      events,
      chatNames,
      coverageLimited,
      chatsScanned: new Set(events.map((e) => e.chatId)).size,
      messagesScanned: events.length,
      officialChatsSkipped: officialChatIds.size,
    }
  }
}
