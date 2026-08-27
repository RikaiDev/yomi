import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { type AttentionTier, scoreAttentionBatch } from '../attention/policy.js'
import { isSquareChatMid } from '../line/client/square-service/client.js'
import {
  fetchStickerImage,
  fetchStickerPackageMetaCached,
  localizedStickerTitle,
} from '../line/client/sticker-meta.js'
import {
  chatEventParticipantMids,
  interpretChatEvent,
} from '../line/core/chat-event.js'
import {
  type FlexMessageDocument,
  interpretFlexMessage,
  processFlexMessage,
} from '../line/core/flex-message.js'
import { sanitizeMessagePreview } from '../line/core/message-preview.js'
import { decryptLineMessage } from '../line/core/message-query-service.js'
import { LineProtocolService } from '../line/core/service.js'
import { handleListConversations } from '../mcp/handlers/conversations.js'
import { resolveConversationNames, resolveSenderNames } from '../mcp/names.js'

export interface CliConversationJsonItem {
  id: string
  title: string
  lastMessage: string
  timeString: string
  timestamp: number
  unreadCount: number
  isMuted: boolean
  isGroup: boolean
  hasMention: boolean
  pictureUrl: string | null
  isOfficial?: boolean
  attentionScore: number
  attentionTier: AttentionTier
  attentionReason: string
}

type AttentionCacheEntry = {
  score: number
  tier: AttentionTier
  reason: string
  updatedAt: number
}
type AttentionCache = Record<string, AttentionCacheEntry>
const attentionCachePath = join(
  process.env.YOMI_DATA_DIR || join(homedir(), '.yomi'),
  'attention-cache.json',
)
const ATTENTION_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
const ATTENTION_CACHE_MAX_ENTRIES = 1000
const ATTENTION_BATCH_SIZE = 32
const ATTENTION_POLICY_VERSION = 5

function attentionSignature(
  item: Pick<
    CliConversationJsonItem,
    'id' | 'lastMessage' | 'isOfficial' | 'isMuted'
  >,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        ATTENTION_POLICY_VERSION,
        item.id,
        item.lastMessage,
        item.isOfficial,
        item.isMuted,
      ]),
    )
    .digest('hex')
}

async function loadAttentionCache(): Promise<AttentionCache> {
  try {
    const cache = JSON.parse(
      await readFile(attentionCachePath, 'utf8'),
    ) as AttentionCache
    const cutoff = Date.now() - ATTENTION_CACHE_TTL_MS
    return Object.fromEntries(
      Object.entries(cache).filter(
        ([, entry]) => (entry.updatedAt || 0) >= cutoff,
      ),
    )
  } catch {
    return {}
  }
}

async function saveAttentionCache(cache: AttentionCache): Promise<void> {
  const bounded = Object.fromEntries(
    Object.entries(cache)
      .sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0))
      .slice(0, ATTENTION_CACHE_MAX_ENTRIES),
  )
  await mkdir(dirname(attentionCachePath), { recursive: true })
  await writeFile(attentionCachePath, JSON.stringify(bounded), { mode: 0o600 })
}

export async function cliClassifyAttentionJson(
  items: CliConversationJsonItem[],
): Promise<
  Array<{
    id: string
    attentionScore: number
    attentionTier: AttentionTier
    attentionReason: string
  }>
> {
  const cache = await loadAttentionCache()
  const batch = items.slice(0, ATTENTION_BATCH_SIZE)
  if (batch.length === 0) return []
  const evaluations = await scoreAttentionBatch(
    batch.map((item) => ({
      id: item.id,
      text: item.lastMessage,
      unreadCount: 0,
      isMuted: item.isMuted,
      isOfficial: item.isOfficial,
      hasMention: item.hasMention,
    })),
  )
  const results = batch.map((item, index) => {
    const result = evaluations[index]
    cache[attentionSignature(item)] = { ...result, updatedAt: Date.now() }
    return {
      id: item.id,
      attentionScore: result.score,
      attentionTier: result.tier,
      attentionReason: result.reason,
    }
  })
  await saveAttentionCache(cache)
  return results
}

export interface CliChatMessageJsonItem {
  id: string
  fromMid: string
  fromName: string
  fromPictureUrl: string | null
  isSelf: boolean
  text: string
  timeString: string
  timestamp: number
  contentType: number
  mediaType: string | null
  mediaUrl: string | null
  actionUrl?: string | null
  flexDocument?: FlexMessageDocument | null
  fileName: string | null
  isDecryptFailure: boolean
  isUnsent: boolean
  mentionRanges: Array<{ location: number; length: number }>
  threadMid?: string | null
  isThreadRoot?: boolean
  threadReplies?: CliChatMessageJsonItem[]
  emojiRanges?: Array<{ location: number; length: number; url: string }>
}

export interface CliStickerPreviewJson {
  stickerId: string
  packageId: string
  data: string
  mimeType: string
}

/** Read-only bridge for the desktop sticker picker. */
export async function cliListStickersJson(language = 'zh_TW'): Promise<any[]> {
  const service = new LineProtocolService()
  if (!(await service.resumeSession())) return []
  const owned = await service.listStickerPackages(language)
  return Promise.all(
    owned.map(async (pkg: any) => {
      const packageId = String(pkg.packageId ?? '')
      if (!packageId) return pkg
      const meta = await fetchStickerPackageMetaCached(packageId)
      return {
        ...pkg,
        title: localizedStickerTitle(
          meta?.title,
          language,
          String(pkg.title ?? ''),
        ),
      }
    }),
  )
}

/** Read-only bridge for owned sticker previews; never sends a message. */
export async function cliStickerPreviewsJson(
  packageId: string,
  limit = 12,
  language = 'en',
): Promise<CliStickerPreviewJson[]> {
  if (!packageId) return []
  const service = new LineProtocolService()
  if (!(await service.resumeSession())) return []
  // The package must be owned before the public CDN metadata is expanded.
  const owned = await service.listStickerPackages(language)
  if (!owned.some((item: any) => String(item.packageId) === packageId))
    return []
  const meta = await fetchStickerPackageMetaCached(packageId)
  if (!meta) return []
  const result: CliStickerPreviewJson[] = []
  for (const stickerId of meta.stickerIds.slice(0, Math.max(1, limit))) {
    const bytes = await fetchStickerImage(stickerId)
    if (!bytes) continue
    result.push({
      stickerId,
      packageId,
      data: bytes.toString('base64'),
      mimeType: 'image/png',
    })
  }
  return result
}

function parseMediaText(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** Only expose web URLs from LINE rich-message metadata. */
function safeWebUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const url = new URL(value.trim())
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? url.toString()
      : null
  } catch {
    return null
  }
}

function firstWebLink(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstWebLink(item)
      if (found) return found
    }
    return null
  }
  const record = value as Record<string, unknown>
  for (const [key, item] of Object.entries(record)) {
    if (key === 'linkUri') {
      const found = safeWebUrl(item)
      if (found) return found
    }
    const nested = firstWebLink(item)
    if (nested) return nested
  }
  return null
}

export function richFields(message: any): {
  altText: string
  mediaUrl: string | null
  actionUrl: string | null
  flexDocument: FlexMessageDocument | null
} {
  const metadata =
    message?.contentMetadata && typeof message.contentMetadata === 'object'
      ? (message.contentMetadata as Record<string, unknown>)
      : {}
  const interpreted = interpretFlexMessage(message)
  const flexDocument = processFlexMessage(message)
  const explicitAlt = sanitizeMessagePreview(metadata.ALT_TEXT) || ''
  const altText = interpreted.summary || explicitAlt
  const mediaUrl = safeWebUrl(metadata.DOWNLOAD_URL) || interpreted.imageUrl
  const redirect = safeWebUrl(metadata.LINE_TAG_REDIRECTOR)
  let markup: unknown = metadata.MARKUP_JSON
  if (typeof markup === 'string') {
    try {
      markup = JSON.parse(markup)
    } catch {
      markup = null
    }
  }
  return {
    altText,
    mediaUrl,
    actionUrl: redirect || interpreted.actionUrl || firstWebLink(markup),
    flexDocument,
  }
}

export { sanitizeMessagePreview } from '../line/core/message-preview.js'

export function messagePlaceholder(
  contentType: number,
  hasOpaquePayload = false,
): string {
  switch (contentType) {
    case 0:
      return hasOpaquePayload ? '[yomi:encrypted]' : '[yomi:message]'
    case 7:
      return '[yomi:sticker]'
    case 4:
      return '[yomi:web]'
    case 5:
      return '[yomi:pdf]'
    case 6:
      return '[yomi:call]'
    case 8:
      return '[yomi:status]'
    case 9:
      return '[yomi:gift]'
    case 10:
      return '[yomi:note]'
    case 11:
      return '[yomi:app]'
    case 12:
      return '[yomi:share]'
    case 13:
      return '[yomi:contact]'
    case 15:
      return '[yomi:location]'
    case 16:
      return '[yomi:post]'
    case 17:
      return '[yomi:rich]'
    case 18:
      return '[yomi:chat_event]'
    case 19:
      return '[yomi:music]'
    case 20:
      return '[yomi:payment]'
    case 21:
      return '[yomi:extended_image]'
    case 22:
      return '[yomi:rich]'
    case 1:
      return '[yomi:image]'
    case 2:
      return '[yomi:video]'
    case 3:
      return '[yomi:audio]'
    case 14:
      return '[yomi:file]'
    default:
      return hasOpaquePayload
        ? '[yomi:encrypted]'
        : `[yomi:line_content:${contentType}]`
  }
}

export function messageFallback(message: any): string {
  if (message?.contentMetadata?.UNSENT === 'true') return '[yomi:unsent]'
  const altText = messageAltText(message?.contentMetadata)
  if (altText) return altText
  return message?.e2eeDecryptFailure
    ? '[yomi:decrypt_failed]'
    : messagePlaceholder(
        Number(message?.contentType || 0),
        Boolean(message?.text),
      )
}

/** Convert LINE's private CALL transport string into a stable UI token. */
export function callHistoryPreview(value: unknown, isSelf: boolean): string {
  if (typeof value !== 'string') return '[yomi:call]'
  const match =
    /^Call History\s*:\s*(\d+)\s+millisecs,\s*Result:\s*(\d+)$/i.exec(
      value.trim(),
    )
  if (!match) return '[yomi:call]'
  const milliseconds = Number(match[1])
  const result = Number(match[2])
  if (result === 16 && milliseconds > 0) {
    return `[yomi:call_duration:${Math.floor(milliseconds / 1000)}]`
  }
  if (result === 77) {
    return isSelf ? '[yomi:call_no_answer]' : '[yomi:call_missed]'
  }
  return '[yomi:call]'
}

function messageAltText(metadata: any): string {
  for (const key of ['ALT_TEXT', 'altText', 'ALT']) {
    const value = sanitizeMessagePreview(metadata?.[key])
    if (value) return value
  }
  return ''
}

function parseMentionRanges(
  metadata: Record<string, unknown>,
): Array<{ location: number; length: number }> {
  if (typeof metadata.MENTION !== 'string') return []
  try {
    const parsed = JSON.parse(metadata.MENTION) as {
      MENTIONEES?: Array<{ S?: string; E?: string }>
    }
    return (parsed.MENTIONEES || []).flatMap((mention) => {
      const location = Number(mention.S)
      const end = Number(mention.E)
      return Number.isInteger(location) &&
        Number.isInteger(end) &&
        end > location
        ? [{ location, length: end - location }]
        : []
    })
  } catch {
    return []
  }
}

function parseEmojiRanges(
  metadata: Record<string, unknown>,
): Array<{ location: number; length: number; url: string }> {
  if (typeof metadata.REPLACE !== 'string') return []
  try {
    const parsed = JSON.parse(metadata.REPLACE) as {
      sticon?: {
        resources?: Array<{
          S?: number
          E?: number
          productId?: string
          sticonId?: string
        }>
      }
    }
    return (parsed.sticon?.resources || []).flatMap((resource) => {
      const location = Number(resource.S)
      const end = Number(resource.E)
      if (
        !Number.isInteger(location) ||
        !Number.isInteger(end) ||
        end <= location ||
        !resource.productId ||
        !resource.sticonId
      )
        return []
      return [
        {
          location,
          length: end - location,
          url: `https://stickershop.line-scdn.net/sticonshop/v1/sticon/${resource.productId}/android/${resource.sticonId}.png`,
        },
      ]
    })
  } catch {
    return []
  }
}

function isRichContentType(contentType: number): boolean {
  return contentType === 17 || contentType === 22
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp || timestamp <= 0) return ''
  const date = new Date(Number(timestamp))
  const now = new Date()

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()

  const hours = date.getHours().toString().padStart(2, '0')
  const minutes = date.getMinutes().toString().padStart(2, '0')

  if (isToday) {
    return `${hours}:${minutes}`
  }
  if (isYesterday) {
    return '昨天'
  }
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

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

function squareMessageContent(message: any): {
  contentType: number
  metadata: any
  text: string | null
} {
  const contentType = Number(message?.contentType ?? message?.[15] ?? 0)
  const metadata = message?.contentMetadata ?? message?.[18]
  const text =
    messageAltText(metadata) ||
    sanitizeMessagePreview(message?.text ?? message?.[10]) ||
    null
  return { contentType, metadata, text }
}

export function isRenderableSquareMessage(message: any): boolean {
  const content = squareMessageContent(message)
  return content.contentType !== 0 || content.text !== null
}

/** Normalize provider-specific message windows to the newest chronological page. */
export function newestMessageWindow(messages: any[], count: number): any[] {
  return [...messages]
    .sort((a, b) => messageTimestamp(a) - messageTimestamp(b))
    .slice(-Math.max(0, count))
}

export async function cliListConversationsJson(
  args: { limit?: number; attentionOnly?: boolean; semantic?: boolean } = {},
): Promise<CliConversationJsonItem[]> {
  const service = new LineProtocolService()
  const ok = await service.resumeSession()
  if (!ok) return []

  try {
    // Advance the Talk revision before reading message boxes. A fresh client
    // process starts with no checkpoint; syncLongPoll now obtains the server's
    // last-op revision before issuing sync, then we persist the monotonic
    // checkpoint through the session-state owner for the next bridge process.
    try {
      await service.client.syncLongPoll(50, 1000)
      if (service.sessionState?.setRevisions) {
        await service.sessionState.setRevisions(
          Number(service.client.revision || 0),
          Number(service.client.globalRevision || 0),
          Number(service.client.individualRevision || 0),
        )
      }
    } catch {}
    const result = await service.client.getAllMessageBoxes({
      lastMessagesPerMessageBoxCount: 1,
      ...(args.limit ? { messageBoxCountLimit: args.limit } : {}),
      withUnreadCount: true,
    })
    const boxes = result.messageBoxes || []
    const chatIds = boxes.map((box: any) => box.id).filter(Boolean)
    const names = await resolveConversationNames(service, chatIds)

    // Resolve contacts picture paths
    const userMids = chatIds.filter((id: string) => id.startsWith('u'))
    const contactMap = new Map<string, any>()
    if (userMids.length > 0) {
      try {
        const contacts = await service.client.getContacts(userMids)
        for (const c of contacts || []) {
          if (c?.mid) contactMap.set(c.mid, c)
        }
      } catch {}
    }

    const conversations: CliConversationJsonItem[] = await Promise.all(
      boxes.map(async (box: any) => {
        let lastMsg = latestMessage(box.lastMessages)
        const boxDeliveredTime = Number(
          box.lastDeliveredMessageId?.deliveredTime || 0,
        )
        // Some LINE responses return a lastMessages array that lags the
        // last-delivered cursor. Fetch one message only for that box so the
        // inbox preview and date cannot remain days behind.
        if (
          box.id &&
          (!lastMsg || messageTimestamp(lastMsg) < boxDeliveredTime)
        ) {
          try {
            const recent = await service.getRecentMessages(box.id, 1)
            const candidate = latestMessage(recent)
            if (
              candidate &&
              messageTimestamp(candidate) >= messageTimestamp(lastMsg)
            ) {
              lastMsg = candidate
            }
          } catch {}
        }
        let preview = '[yomi:no_message]'
        let timestamp = 0

        if (lastMsg) {
          timestamp = messageTimestamp(lastMsg)
          const rich = isRichContentType(Number(lastMsg.contentType))
            ? richFields(lastMsg)
            : null
          const rawPreview =
            Number(lastMsg.contentType) === 6
              ? callHistoryPreview(
                  lastMsg.text,
                  lastMsg.from === service.profile?.mid,
                )
              : rich?.altText ||
                messageAltText(lastMsg.contentMetadata) ||
                sanitizeMessagePreview(lastMsg.text)
          if (rawPreview) {
            preview = rawPreview
          } else {
            const decrypted = await decryptLineMessage(
              service.e2eeManager,
              lastMsg,
              box.id,
            )
            const decryptedPreview = sanitizeMessagePreview(decrypted?.text)
            if (decryptedPreview) preview = decryptedPreview
            else if (lastMsg.contentType)
              preview = messagePlaceholder(Number(lastMsg.contentType))
            else if (lastMsg.text) preview = messagePlaceholder(0, true)
          }
        }

        const isGroup = box.id?.startsWith('c') || box.id?.startsWith('r')
        const defaultTitle = isGroup ? '群組對話' : '好友對話'
        const title = names.get(box.id) || defaultTitle
        const chatCached = service.chatCache.get(box.id)
        const contact = contactMap.get(box.id)

        let picPath: string | null = null
        if (isGroup && chatCached?.picturePath) {
          picPath = chatCached.picturePath
        } else if (!isGroup && contact?.picturePath) {
          picPath = contact.picturePath
        }

        const pictureUrl = picPath
          ? `https://obs.line-scdn.net/${picPath.replace(/^\/+/, '')}`
          : null
        const isMuted = isGroup
          ? Boolean(chatCached?.notificationDisabled)
          : Boolean(
              contact?.notificationDisabled ?? chatCached?.notificationDisabled,
            )
        const unreadCount = box.unreadCount ?? 0

        return {
          id: box.id,
          title,
          lastMessage: preview.replace(/\n+/g, ' ').trim(),
          timeString: formatTimestamp(timestamp),
          timestamp,
          unreadCount,
          isMuted,
          isGroup,
          hasMention: false,
          pictureUrl,
          isOfficial: Boolean(contact?.isOfficial),
          attentionScore: 0,
          attentionTier: 'pending' as AttentionTier,
          attentionReason: 'pending',
        }
      }),
    )

    // OpenChat (SquareService) is a separate inbox. Its `m...`/legacy `t...`
    // chats never
    // appear in TalkService message boxes, so merge the two authoritative
    // lists before attention scoring and sorting. SquareChatStatus supplies
    // the authoritative latest message cheaply enough for background polls.
    try {
      const squareChats = await service.client.getJoinedSquareChats(
        args.limit ?? 100,
      )
      const hydratedSquareChats = await Promise.all(
        squareChats.map(async (chat: any) => {
          if (chat.lastMessage) return chat
          let hydrated = chat
          try {
            const status = await service.client.getSquareChatStatus(chat.id)
            hydrated = {
              ...chat,
              lastMessage: status?.[3]?.[1] || null,
              lastSenderName: status?.[4] || null,
              unreadCount: Number(status?.[5]?.[2] || chat.unreadCount),
            }
          } catch {}
          if (isRenderableSquareMessage(hydrated.lastMessage)) return hydrated
          try {
            const messages = await service.client.getSquareChatMessages(
              chat.id,
              100,
            )
            return {
              ...hydrated,
              lastMessage:
                [...messages].reverse().find(isRenderableSquareMessage) ?? null,
            }
          } catch {
            return hydrated
          }
        }),
      )
      for (const chat of hydratedSquareChats) {
        if (conversations.some((item) => item.id === chat.id)) continue
        const last = chat.lastMessage
        const timestamp = Number(
          last?.createdTime || last?.[6] || last?.[5] || 0,
        )
        const { contentType, text } = squareMessageContent(last)
        conversations.push({
          id: chat.id,
          title: chat.name,
          lastMessage:
            text ||
            (contentType
              ? messagePlaceholder(contentType)
              : '[yomi:no_message]'),
          timeString: formatTimestamp(timestamp),
          timestamp,
          unreadCount: chat.unreadCount,
          isMuted: chat.isMuted,
          isGroup: true,
          hasMention: false,
          pictureUrl: chat.pictureHash
            ? `https://obs.line-scdn.net/${chat.pictureHash}`
            : null,
          isOfficial: false,
          attentionScore: 0,
          attentionTier: 'pending',
          attentionReason: 'pending',
        })
      }
    } catch {
      // Older/regional accounts may not expose SquareService. Ordinary LINE
      // conversations must remain usable when OpenChat discovery is absent.
    }

    const cache = await loadAttentionCache()
    const pending: number[] = []
    conversations.forEach((conversation, index) => {
      const cached = cache[attentionSignature(conversation)]
      if (cached) {
        conversation.attentionScore = cached.score
        conversation.attentionTier = cached.tier
        conversation.attentionReason = cached.reason
      } else if (conversation.isMuted || conversation.unreadCount === 0) {
        conversation.attentionScore = conversation.isMuted ? -100 : 0
        conversation.attentionTier = 'filtered'
        conversation.attentionReason = conversation.isMuted ? 'muted' : 'read'
      } else {
        pending.push(index)
        conversation.attentionScore = 0
        conversation.attentionTier = 'pending'
        conversation.attentionReason = 'pending'
      }
    })

    if (args.semantic && pending.length > 0) {
      try {
        const evaluations = await scoreAttentionBatch(
          pending.map((index) => {
            const conversation = conversations[index]
            return {
              id: conversation.id,
              text: conversation.lastMessage,
              unreadCount: 0,
              isMuted: conversation.isMuted,
              isOfficial: conversation.isOfficial,
              hasMention: conversation.hasMention,
            }
          }),
        )
        pending.forEach((conversationIndex, resultIndex) => {
          const conversation = conversations[conversationIndex]
          const result = evaluations[resultIndex]
          cache[attentionSignature(conversation)] = {
            ...result,
            updatedAt: Date.now(),
          }
          conversation.attentionScore = result.score
          conversation.attentionTier = result.tier
          conversation.attentionReason = result.reason
        })
        await saveAttentionCache(cache)
      } catch {
        pending.forEach((index) => {
          conversations[index].attentionReason = 'ai_unavailable'
        })
      }
    }

    // Sort by timestamp descending
    conversations.sort((a, b) => b.timestamp - a.timestamp)

    if (args.attentionOnly) {
      return conversations.filter((c) =>
        ['now', 'today', 'know'].includes(c.attentionTier),
      )
    }

    return conversations
  } catch {
    return []
  }
}

export async function cliGetChatMessagesJson(
  chatId: string,
  count = 30,
): Promise<CliChatMessageJsonItem[]> {
  const service = new LineProtocolService()
  const ok = await service.resumeSession()
  if (!ok) return []

  try {
    if (isSquareChatMid(chatId)) {
      // Square's small-limit response can be the oldest edge of its server
      // window rather than the newest page. Fetch the protocol's full recent
      // window, normalize by timestamp, then expose the requested tail.
      const squareWindow = await service.client.getSquareChatMessages(
        chatId,
        Math.max(100, count),
      )
      let latestStatusMessage: any = null
      try {
        latestStatusMessage =
          await service.client.getSquareChatLatestMessage(chatId)
      } catch {}
      const combinedWindow = latestStatusMessage
        ? [...squareWindow, latestStatusMessage]
        : squareWindow
      const meaningfulWindow = combinedWindow.filter(
        (message: any) =>
          Number(message.contentType ?? 0) !== 0 ||
          Boolean(sanitizeMessagePreview(message.text)) ||
          Boolean(messageAltText(message.contentMetadata)),
      )
      const messages = newestMessageWindow(meaningfulWindow, count)
      const shapeSquareMessage = (message: any): CliChatMessageJsonItem => ({
        id: message.id,
        fromMid: message.fromMid,
        fromName: message.isSelf ? '我' : message.fromName,
        fromPictureUrl: message.fromPictureUrl,
        isSelf: message.isSelf,
        text:
          (message.contentType === 0
            ? sanitizeMessagePreview(message.text) ||
              messageAltText(message.contentMetadata)
            : '') ||
          (message.contentType ? messagePlaceholder(message.contentType) : ''),
        timeString: formatTimestamp(message.createdTime),
        timestamp: message.createdTime,
        contentType: message.contentType,
        mediaType:
          (
            {
              1: 'image',
              2: 'video',
              3: 'audio',
              7: 'sticker',
              14: 'file',
              17: 'rich',
              22: 'rich',
            } as Record<number, string>
          )[message.contentType] || null,
        mediaUrl:
          message.contentType === 7 && message.contentMetadata?.STKID
            ? `https://stickershop.line-scdn.net/stickershop/v1/sticker/${message.contentMetadata.STKID}/android/sticker.png`
            : null,
        actionUrl: null,
        fileName: message.contentMetadata?.FILE_NAME || null,
        isDecryptFailure: false,
        isUnsent: false,
        mentionRanges: [],
        threadMid: message.threadMid,
        isThreadRoot: message.isThreadRoot,
        emojiRanges: parseEmojiRanges(message.contentMetadata || {}),
      })
      return Promise.all(
        messages.map(async (message: any) => {
          const shaped = shapeSquareMessage(message)
          if (!message.isThreadRoot || !message.threadMid) return shaped
          try {
            const threadMessages = await service.client.getSquareChatMessages(
              chatId,
              50,
              message.threadMid,
            )
            shaped.threadReplies = threadMessages
              .filter((reply: any) => reply.id !== message.id)
              .map(shapeSquareMessage)
          } catch {
            shaped.threadReplies = []
          }
          return shaped
        }),
      )
    }
    // Always use the service-owned query boundary here. It opportunistically
    // decrypts E2EE envelopes; reading service.client directly leaves media
    // messages with contentType=0 and opaque text, which makes image/file
    // rendering look empty even though LINE returned the message.
    const rawMessages = await service.getRecentMessages(chatId, count)
    const mids = Array.from(
      new Set(
        rawMessages
          .flatMap((message: any) => [
            message.from,
            ...chatEventParticipantMids(message),
          ])
          .filter(Boolean),
      ),
    )
    const names = await resolveSenderNames(service, mids)

    const userMids = Array.from(
      new Set(mids.filter((m: string) => m.startsWith('u'))),
    )
    const contactMap = new Map<string, any>()
    if (userMids.length > 0) {
      try {
        const contacts = await service.client.getContacts(userMids)
        for (const c of contacts || []) {
          if (c?.mid) contactMap.set(c.mid, c)
        }
      } catch {}
    }

    const selfMid = service.profile?.mid
    const selfName = service.profile?.displayName || '我'
    const selfPicPath = service.profile?.picturePath
    const selfPicUrl = selfPicPath
      ? `https://obs.line-scdn.net/${selfPicPath.replace(/^\/+/, '')}`
      : null

    const formatted: CliChatMessageJsonItem[] = rawMessages.map((m: any) => {
      const isSelf = m.from === selfMid
      const fromName = isSelf ? selfName : names.get(m.from) || '成員'
      const contact = contactMap.get(m.from)
      const picPath = isSelf ? selfPicPath : contact?.picturePath
      const fromPictureUrl = isSelf
        ? selfPicUrl
        : picPath
          ? `https://obs.line-scdn.net/${picPath.replace(/^\/+/, '')}`
          : null

      const contentType = Number(m.contentType || 0)
      const metadata = m.contentMetadata || {}
      const mediaText = parseMediaText(m.text)
      const stickerId = metadata.STKID || metadata.stickerId
      const rich = isRichContentType(contentType) ? richFields(m) : null
      let text = sanitizeMessagePreview(m.text)
      if (contentType === 6) text = callHistoryPreview(m.text, isSelf)
      if (contentType === 18) text = interpretChatEvent(m, names)
      if (rich?.altText) text = rich.altText
      if (!text) {
        text = messageFallback(m)
      }

      const timestamp = Number(m.deliveredTime || m.createdTime || 0)

      return {
        id: String(m.id),
        fromMid: m.from || '',
        fromName,
        fromPictureUrl,
        isSelf,
        text,
        timeString: formatTimestamp(timestamp),
        timestamp,
        contentType,
        mediaType:
          (
            {
              1: 'image',
              2: 'video',
              3: 'audio',
              6: 'call',
              7: 'sticker',
              14: 'file',
              17: 'rich',
              22: 'rich',
            } as Record<number, string>
          )[contentType] || null,
        mediaUrl:
          rich?.mediaUrl ||
          (stickerId
            ? `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/android/sticker.png`
            : null),
        actionUrl: rich?.actionUrl || null,
        flexDocument: rich?.flexDocument || null,
        fileName:
          (typeof mediaText.fileName === 'string'
            ? mediaText.fileName
            : null) ||
          (typeof metadata.FILE_NAME === 'string'
            ? metadata.FILE_NAME
            : null) ||
          (typeof metadata.FILE_NAME_ORIGINAL === 'string'
            ? metadata.FILE_NAME_ORIGINAL
            : null) ||
          (typeof metadata.name === 'string' ? metadata.name : null),
        isDecryptFailure: Boolean(m.e2eeDecryptFailure),
        isUnsent: metadata.UNSENT === 'true',
        mentionRanges: parseMentionRanges(metadata),
        emojiRanges: parseEmojiRanges(metadata),
      }
    })

    // Chronological order (oldest to newest) for chat bubble view
    formatted.sort((a, b) => a.timestamp - b.timestamp)
    return formatted
  } catch {
    return []
  }
}

export async function cliMarkReadJson(
  chatId: string,
  messageId?: string,
): Promise<{ success: boolean; marked: boolean }> {
  const service = new LineProtocolService()
  const ok = await service.resumeSession()
  if (!ok) return { success: false, marked: false }

  try {
    const res = await service.markChatRead(chatId, messageId)
    return { success: true, marked: res.marked }
  } catch {
    return { success: false, marked: false }
  }
}

export async function cliRecentSummary(): Promise<string> {
  const service = new LineProtocolService()
  const ok = await service.resumeSession()
  if (!ok) {
    return '【LINE 狀態】尚未連線或憑證已過期，請先於選單列重新登入。'
  }

  try {
    const result = await handleListConversations(service, { limit: 12 })
    const rawText = result.content?.[0]?.text || ''

    const name = service.profile?.displayName || 'LINE User'
    let output = `【LINE 即時訊息摘要 — ${name}】\n• 加密狀態：Letter-Sealing (E2EE) 已解密安全連線\n\n`

    // Parse TOON format lines
    const lines = rawText.split('\n').filter((l) => l.trim().length > 0)
    const chats: Array<{ name: string; unread: number; preview: string }> = []

    for (const line of lines) {
      if (line.startsWith('[') || line.includes('{id,')) continue
      // Format: id,lastMessagePreview,name,unreadCount
      // Note that preview might contain quotes or escaped newlines
      const trimmed = line.trim()
      const parts = trimmed.split(',')
      if (parts.length >= 4) {
        const unread = parseInt(parts[parts.length - 1], 10) || 0
        const chatName = parts[parts.length - 2] || '聊天室'
        const previewRaw = parts.slice(1, parts.length - 2).join(',')
        const preview =
          previewRaw === 'null'
            ? '(無文字或貼圖/媒體)'
            : previewRaw.replace(/^"|"$/g, '').replace(/\\n/g, ' ')
        chats.push({ name: chatName, unread, preview })
      }
    }

    if (chats.length > 0) {
      chats.forEach((chat) => {
        const unreadBadge =
          chat.unread > 0 ? ` 🔴 **[未讀 ${chat.unread} 則]**` : ''
        output += `• **${chat.name}**${unreadBadge}\n  ↳ 「${chat.preview}」\n\n`
      })
    } else {
      output += '目前沒有最近的聊天室紀錄。\n'
    }

    return output.trim()
  } catch (err: any) {
    return `查詢 LINE 訊息時發生錯誤：${err.message || String(err)}`
  }
}
