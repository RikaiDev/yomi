/**
 * Read-only LINE OpenChat (SquareService) capability.
 *
 * OpenChat is a separate service from TalkService: joined chats use `t...`
 * MIDs and never appear in TalkService message boxes. Keep the protocol
 * boundary explicit so callers cannot accidentally treat Square messages as
 * ordinary group messages.
 */

import { LINE_APP_CONFIG } from '../../core/config.js'
import {
  i32Field,
  i64Field,
  mapField,
  setField,
  stringField,
  structField,
} from '../../core/thrift/index.js'

export interface JoinedSquareChat {
  id: string
  squareMid: string | null
  memberMid: string | null
  name: string
  pictureHash: string | null
  unreadCount: number
  lastMessage: any | null
  lastSenderName: string | null
  isMuted: boolean
}

export interface SquareChatMessage {
  id: string
  chatId: string
  fromMid: string
  fromName: string
  fromPictureUrl: string | null
  isSelf: boolean
  text: string
  createdTime: number
  contentType: number
  contentMetadata: Record<string, string>
  threadMid: string | null
  isThreadRoot: boolean
}

function mapEntries(value: any): Array<[string, any]> {
  if (value instanceof Map) return Array.from(value.entries())
  if (value && typeof value === 'object') return Object.entries(value)
  return []
}

/** LINE currently emits `m...` SquareChat MIDs; older schemas used `t...`. */
export function isSquareChatMid(value: string): boolean {
  return value.startsWith('m') || value.startsWith('t')
}

function normalizeJoinedChat(
  chat: any,
  status: any,
  member?: any,
): JoinedSquareChat | null {
  const id = String(chat?.[1] || '')
  if (!isSquareChatMid(id)) return null
  const lastSquareMessage = status?.[3]
  return {
    id,
    squareMid: chat?.[2] ? String(chat[2]) : null,
    memberMid: member?.[1] ? String(member[1]) : null,
    name: String(chat?.[4] || 'LINE 社群'),
    pictureHash: chat?.[5] ? String(chat[5]) : null,
    unreadCount: Number(status?.[5]?.[2] || 0),
    lastMessage: lastSquareMessage?.[1] || null,
    lastSenderName: status?.[4] ? String(status[4]) : null,
    isMuted: member?.[5] === false,
  }
}

function eventMessage(event: any): SquareChatMessage | null {
  const payload = event?.[4]
  const received = payload?.[1]
  const sent = payload?.[2]
  const mutated = payload?.[41]
  const notification = payload?.[30]
  const envelope = received || sent || mutated || notification
  const squareMessage = envelope?.[2]
  const message = squareMessage?.[1]
  if (!message) return null
  const chatId = String(envelope?.[1] || message?.[2] || '')
  const id = String(message?.[4] || '')
  if (!chatId || !id) return null
  const fromMid = String(message?.[1] || '')
  return {
    id,
    chatId,
    fromMid,
    fromName: fromMid ? `成員 ${fromMid.slice(-4)}` : '匿名成員',
    fromPictureUrl: null,
    isSelf: Boolean(sent),
    text: typeof message?.[10] === 'string' ? message[10] : '',
    createdTime: Number(message?.[6] || message?.[5] || event?.[2] || 0),
    contentType: Number(message?.[15] || 0),
    contentMetadata:
      message?.[18] && typeof message[18] === 'object' ? message[18] : {},
    threadMid: squareMessage?.[6]?.[1]
      ? String(squareMessage[6][1])
      : envelope?.[7]
        ? String(envelope[7])
        : null,
    isThreadRoot: Boolean(squareMessage?.[6]?.[2]),
  }
}

export function createSquareClient(runtime) {
  const memberProfiles = new Map<
    string,
    { displayName: string; pictureUrl: string | null }
  >()

  async function resolveMember(squareMemberMid: string) {
    const cached = memberProfiles.get(squareMemberMid)
    if (cached) return cached
    try {
      const result = await runtime.sendCompact(
        LINE_APP_CONFIG.squarePath,
        'getSquareMember',
        [structField(1, [stringField(1, squareMemberMid)])],
      )
      const member = result.fields?.[0]?.[1]
      const displayName = String(member?.[3] || '').trim()
      const pictureHash = String(member?.[4] || '').trim()
      if (displayName) {
        const profile = {
          displayName,
          pictureUrl: pictureHash
            ? `https://obs.line-scdn.net/${pictureHash.replace(/^\/+/, '')}`
            : null,
        }
        memberProfiles.set(squareMemberMid, profile)
        return profile
      }
    } catch (error) {
      if (process.env.YOMI_DEBUG_SQUARE_MEMBER === '1') {
        console.error(
          '[square] getSquareMember failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    return null
  }

  async function resolveMembers(squareMemberMids: string[]) {
    const unresolved = squareMemberMids.filter(
      (mid) => !memberProfiles.has(mid),
    )
    if (unresolved.length === 0) return
    try {
      const result = await runtime.sendCompact(
        LINE_APP_CONFIG.squarePath,
        'getSquareMembers',
        [structField(1, [setField(2, 11, unresolved)])],
      )
      const raw = result.fields?.[0]?.[1]
      const candidates =
        raw && typeof raw?.[1] === 'string'
          ? [raw]
          : mapEntries(raw).map(([, member]) => member)
      for (const member of candidates) {
        const mid = String(member?.[1] || '')
        const displayName = String(member?.[3] || '').trim()
        const pictureHash = String(member?.[4] || '').trim()
        if (!mid || !displayName) continue
        memberProfiles.set(mid, {
          displayName,
          pictureUrl: pictureHash
            ? `https://obs.line-scdn.net/${pictureHash.replace(/^\/+/, '')}`
            : null,
        })
      }
    } catch (error) {
      if (process.env.YOMI_DEBUG_SQUARE_MEMBER === '1') {
        console.error(
          '[square] getSquareMembers failed',
          error instanceof Error ? error.message : String(error),
        )
      }
    }
  }

  return {
    async getJoinedSquareChats(limit = 100): Promise<JoinedSquareChat[]> {
      const chats: JoinedSquareChat[] = []
      let continuationToken: string | undefined
      const seenTokens: string[] = []
      try {
        for (;;) {
          const request = [i32Field(3, Math.max(1, Math.min(limit, 100)))]
          if (continuationToken)
            request.unshift(stringField(2, continuationToken))
          const result = await runtime.sendCompact(
            LINE_APP_CONFIG.squarePath,
            'getJoinedSquareChats',
            [structField(1, request)],
          )
          const response = result.fields?.[0]
          const statuses = mapEntries(response?.[3])
          const members = mapEntries(response?.[2])
          for (const raw of Array.isArray(response?.[1]) ? response[1] : []) {
            const id = String(raw?.[1] || '')
            const chat = normalizeJoinedChat(
              raw,
              statuses.find(([key]) => key === id)?.[1],
              members.find(([key]) => key === id)?.[1],
            )
            if (chat) chats.push(chat)
          }
          const next = response?.[4] ? String(response[4]) : ''
          if (!next || seenTokens.includes(next) || chats.length >= limit) break
          seenTokens.push(next)
          continuationToken = next
        }
      } catch (error) {
        // LINE's Desktop identity currently answers getJoinedSquareChats with
        // `501 NO XLT`. A bootstrap fetchMyEvents(subscriptionId=0) returns
        // the authoritative CREATE_SQUARE_CHAT_MEMBER snapshots instead.
        chats.length = 0
        let eventContinuation: string | undefined
        const seenEventTokens: string[] = []
        for (;;) {
          const request: any[] = [i64Field(1, 0), i32Field(3, 100)]
          if (eventContinuation) request.push(stringField(4, eventContinuation))
          const result = await runtime.sendCompact(
            LINE_APP_CONFIG.squarePath,
            'fetchMyEvents',
            [structField(1, request)],
          )
          const response = result.fields?.[0]
          for (const event of Array.isArray(response?.[2]) ? response[2] : []) {
            const createdMembership = event?.[4]?.[17]
            const chat = normalizeJoinedChat(
              createdMembership?.[1],
              createdMembership?.[2],
              createdMembership?.[3],
            )
            if (chat) chats.push(chat)
          }
          const next = response?.[4] ? String(response[4]) : ''
          if (!next || seenEventTokens.includes(next) || chats.length >= limit)
            break
          seenEventTokens.push(next)
          eventContinuation = next
        }
        if (chats.length === 0) throw error
      }
      return chats
        .filter(
          (chat, index) =>
            chats.findIndex((item) => item.id === chat.id) === index,
        )
        .slice(0, limit)
    },

    async getSquareChatMessages(
      chatId: string,
      limit = 40,
      threadMid?: string,
    ): Promise<SquareChatMessage[]> {
      if (!isSquareChatMid(chatId)) throw new Error('Invalid OpenChat MID')
      const result = await runtime.sendCompact(
        LINE_APP_CONFIG.squarePath,
        'fetchSquareChatEvents',
        [
          structField(1, [
            i64Field(1, 0),
            stringField(2, chatId),
            i32Field(4, Math.max(1, Math.min(limit, 100))),
            i32Field(5, 1),
            i32Field(6, 1),
            i32Field(8, 1),
            ...(threadMid ? [stringField(9, threadMid)] : []),
          ]),
        ],
      )
      const events = result.fields?.[0]?.[2]
      const messages: SquareChatMessage[] = []
      for (const event of Array.isArray(events) ? events : []) {
        const message = eventMessage(event)
        if (!message || message.chatId !== chatId) continue
        const existingIndex = messages.findIndex(
          (item) => item.id === message.id,
        )
        if (existingIndex >= 0) messages[existingIndex] = message
        else messages.push(message)
      }
      const senderMids = [
        ...new Set(messages.map((message) => message.fromMid).filter(Boolean)),
      ]
      await resolveMembers(senderMids)
      await Promise.all(
        senderMids.map(async (mid) => {
          const profile = await resolveMember(mid)
          if (!profile) return
          for (const message of messages) {
            if (message.fromMid !== mid) continue
            message.fromName = profile.displayName
            message.fromPictureUrl = profile.pictureUrl
          }
        }),
      )
      return messages
        .sort((a, b) => a.createdTime - b.createdTime)
        .slice(-limit)
    },

    async getSquareChatStatus(chatId: string): Promise<any> {
      if (!isSquareChatMid(chatId)) throw new Error('Invalid OpenChat MID')
      const result = await runtime.sendCompact(
        LINE_APP_CONFIG.squarePath,
        'getSquareChatStatus',
        [structField(1, [stringField(2, chatId)])],
      )
      return result.fields?.[0]?.[1] || null
    },

    async getSquareChatLatestMessage(
      chatId: string,
    ): Promise<SquareChatMessage | null> {
      if (!isSquareChatMid(chatId)) throw new Error('Invalid OpenChat MID')
      const result = await runtime.sendCompact(
        LINE_APP_CONFIG.squarePath,
        'getSquareChatStatus',
        [structField(1, [stringField(2, chatId)])],
      )
      const status = result.fields?.[0]?.[1]
      const raw = status?.[3]?.[1]
      if (!raw?.[4]) return null
      const fromMid = String(raw?.[1] || '')
      const profile = fromMid ? await resolveMember(fromMid) : null
      return {
        id: String(raw[4]),
        chatId,
        fromMid,
        fromName:
          profile?.displayName || String(status?.[4] || '') || '匿名成員',
        fromPictureUrl: profile?.pictureUrl || null,
        isSelf: false,
        text: typeof raw?.[10] === 'string' ? raw[10] : '',
        createdTime: Number(raw?.[6] || raw?.[5] || 0),
        contentType: Number(raw?.[15] || 0),
        contentMetadata:
          raw?.[18] && typeof raw[18] === 'object' ? raw[18] : {},
        threadMid: null,
        isThreadRoot: false,
      }
    },

    async markSquareChatRead(chatId: string, messageId: string): Promise<void> {
      if (!isSquareChatMid(chatId)) throw new Error('Invalid OpenChat MID')
      if (!messageId) throw new Error('OpenChat message id required')
      await runtime.sendCompact(LINE_APP_CONFIG.squarePath, 'markAsRead', [
        structField(1, [stringField(2, chatId), stringField(4, messageId)]),
      ])
    },

    async sendSquareMessage(
      chatId: string,
      text: string,
      contentMetadata: Record<string, string> = {},
    ): Promise<any> {
      if (!isSquareChatMid(chatId)) throw new Error('Invalid OpenChat MID')
      const messageFields: any[] = [
        stringField(2, chatId),
        stringField(10, text),
        i32Field(15, 0),
      ]
      if (Object.keys(contentMetadata).length > 0) {
        messageFields.push(mapField(18, 11, 11, contentMetadata))
      }
      const result = await runtime.sendCompact(
        LINE_APP_CONFIG.squarePath,
        'sendMessage',
        [
          structField(1, [
            i32Field(1, runtime.seq++),
            stringField(2, chatId),
            structField(3, [structField(1, messageFields), i64Field(4, 4)]),
          ]),
        ],
      )
      return result.fields?.[0]?.[1] || null
    },
  }
}
