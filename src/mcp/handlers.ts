/**
 * Yomi MCP tool handlers — the read-only LINE operations behind each tool
 * name in server.ts. Split out purely to keep server.ts (the wiring/
 * dispatch file) under the project's 200-scc-line cap; behavior owned here
 * is unchanged from what previously lived inline in server.ts.
 *
 * `login`/`login_complete` live in handlers-login.ts instead, split out
 * separately to keep this file under the 500-scc-line module cap; `toolError`
 * below is shared by both files.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import {
  fetchStickerImage,
  fetchStickerPackageMeta,
} from '../line/client/sticker-meta.js'
import { buildMentionMetadata, type Mention } from '../line/core/mention.js'
import { decryptLineMessage } from '../line/core/message-query-service.js'
import type { LineProtocolService } from '../line/core/service.js'
import { getExcludedChatIds } from '../search/scope.js'
import { createCliLogger } from '../util/log.js'
import {
  fetchLineMessageImage,
  fetchLineMessageMedia,
  LineMediaAccessError,
  resolveLineMediaDescriptor,
  resolveLineMediaType,
} from './media.js'
import {
  resolveConversationNames,
  resolveSenderNames,
  resolveUserNames,
} from './names.js'
import { createPhiAccumulator, maskInto, phiNote } from './phi-guard.js'

const log = createCliLogger('Yomi')

// Yomi logs in on its own (via the `login`/`login_complete` tools, or
// `npx @rikaidev/yomi login`); it does not depend on inboxd for anything.
export const NO_CREDENTIALS_MESSAGE =
  'No persisted LINE session. Call the `login` tool, or run `npx @rikaidev/yomi login` in a terminal.'

/**
 * Build the always-fresh session-required error payload.
 *
 * @returns MCP tool error content.
 */
export function sessionRequiredError() {
  return {
    content: [{ type: 'text' as const, text: NO_CREDENTIALS_MESSAGE }],
    isError: true,
  }
}

/**
 * Build a plain-text MCP tool error payload.
 *
 * @param message - Human-readable error message.
 * @returns MCP tool error content.
 */
export function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
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
 * Handle `send_message` — REALLY sends a text message to a real LINE
 * conversation, E2EE-encrypted for the target (pairwise for a 1:1 `u...`
 * chat, group key for `c.../r...`). Exactly one send per call: no retry,
 * no queueing, no background delivery. If the E2EE key material cannot be
 * resolved, the underlying encrypt call throws and this returns an honest
 * error — it never falls back to sending plaintext.
 *
 * `mentions`, when provided, are validated against `args.text` and encoded
 * into `contentMetadata.MENTION` (see `../line/core/mention.ts`) so LINE
 * renders the `@name` already present in `text` as a real, notifying
 * mention. Validation failure (bad offsets, overlap, a range not starting
 * at `@`) returns an honest tool error and sends nothing — a malformed
 * mention must never silently degrade into a plain, non-notifying string.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result with the sent message id.
 */
export async function handleSendMessage(
  service: LineProtocolService,
  args: {
    chatId: string
    text: string
    mentions?: Mention[]
    replyToMessageId?: string
  },
) {
  if (!args.chatId || !args.text) {
    return toolError('chatId and text are required.')
  }
  let contentMetadata: Record<string, string> | undefined
  if (args.mentions && args.mentions.length > 0) {
    try {
      contentMetadata = {
        MENTION: buildMentionMetadata(args.text, args.mentions),
      }
    } catch (error: any) {
      return toolError(`Invalid mentions: ${error?.message ?? String(error)}`)
    }
  }
  // A reply sets three request fields (NOT contentMetadata): relatedMessageId
  // (21), messageRelationType (22 = MessageRelationType.REPLY = 3), and
  // relatedMessageServiceCode (24 = ServiceCode.TALK = 1). The latter two are
  // i32 enums; LINE rejects the message if they are missing or the wrong type.
  // LINE renders the quote from these and reflects the relation into the
  // recipient's contentMetadata on delivery.
  const reply = args.replyToMessageId
    ? {
        relatedMessageId: args.replyToMessageId,
        messageRelationType: 3,
        relatedMessageServiceCode: 1,
      }
    : undefined
  const sent = await service.sendMessage(
    args.chatId,
    args.text,
    contentMetadata,
    reply,
  )
  const messageId = sent?.id ?? sent?.messageId ?? null
  log.info('send_message.sent', { chatId: args.chatId, messageId })
  let read = false
  try {
    const r = await service.markChatRead(args.chatId)
    read = r.marked
  } catch (error: any) {
    log.warn('send_message.mark_read_failed', {
      chatId: args.chatId,
      error: error?.message ?? String(error),
    })
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ sent: true, messageId, read }, null, 2),
      },
    ],
  }
}

/**
 * Handle `send_image` — REALLY sends an E2EE image to a real LINE
 * conversation right now (upload-then-send: encrypted original + preview
 * object uploaded to OBS, then the key material sealed in an E2EE data
 * message). Works for 1:1 chats, groups, and rooms — see the dispatch
 * logic in message-command-service.ts's `sendImage`. Exactly one send per
 * call: no retry, no queueing, no background delivery. If the E2EE key
 * material cannot be resolved (including a group whose key cannot be
 * resolved) or the OBS upload is rejected, this returns an honest error —
 * it never fabricates a success.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result with the sent message id and uploaded object id.
 */
export async function handleSendImage(
  service: LineProtocolService,
  args: { chatId: string; imagePath?: string; imageBase64?: string },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  const hasPath = Boolean(args.imagePath)
  const hasBase64 = Boolean(args.imageBase64)
  if (hasPath === hasBase64) {
    return toolError('Provide exactly one of imagePath or imageBase64.')
  }

  let imageBytes: Buffer
  let fileName: string | null = null
  if (args.imagePath) {
    try {
      imageBytes = await fs.readFile(args.imagePath)
    } catch (error: any) {
      return toolError(
        `Could not read imagePath "${args.imagePath}": ${error?.message ?? String(error)}`,
      )
    }
    fileName = path.basename(args.imagePath)
  } else {
    imageBytes = Buffer.from(args.imageBase64 as string, 'base64')
  }

  if (imageBytes.length === 0) {
    return toolError('Resolved image is empty.')
  }

  const result = await service.sendImage(args.chatId, imageBytes, fileName)
  log.info('send_image.sent', {
    chatId: args.chatId,
    messageId: result?.messageId,
    oid: result?.oid,
  })
  let read = false
  try {
    const r = await service.markChatRead(args.chatId)
    read = r.marked
  } catch (error: any) {
    log.warn('send_image.mark_read_failed', {
      chatId: args.chatId,
      error: error?.message ?? String(error),
    })
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            messageId: result?.messageId ?? null,
            oid: result?.oid ?? null,
            sent: true,
            read,
          },
          null,
          2,
        ),
      },
    ],
  }
}

/**
 * Handle `send_file` — REALLY sends an E2EE file attachment to a real LINE
 * conversation right now. Mirrors handleSendImage but for arbitrary files: the
 * bytes come from `filePath` or `fileBase64`, and `fileName` (required for the
 * base64 form) is sealed E2EE so the recipient sees the original name. One send
 * per call; on any failure it returns an honest error and sends nothing.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleSendFile(
  service: LineProtocolService,
  args: {
    chatId: string
    filePath?: string
    fileBase64?: string
    fileName?: string
  },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  const hasPath = Boolean(args.filePath)
  const hasBase64 = Boolean(args.fileBase64)
  if (hasPath === hasBase64) {
    return toolError('Provide exactly one of filePath or fileBase64.')
  }

  let fileBytes: Buffer
  let fileName: string
  if (args.filePath) {
    try {
      fileBytes = await fs.readFile(args.filePath)
    } catch (error: any) {
      return toolError(
        `Could not read filePath "${args.filePath}": ${error?.message ?? String(error)}`,
      )
    }
    fileName = args.fileName || path.basename(args.filePath)
  } else {
    if (!args.fileName) {
      return toolError('fileName is required when sending fileBase64.')
    }
    fileBytes = Buffer.from(args.fileBase64 as string, 'base64')
    fileName = args.fileName
  }

  if (fileBytes.length === 0) {
    return toolError('Resolved file is empty.')
  }

  const result = await service.sendFile(args.chatId, fileBytes, fileName)
  log.info('send_file.sent', {
    chatId: args.chatId,
    messageId: result?.messageId,
    oid: result?.oid,
    fileName,
  })
  let read = false
  try {
    const r = await service.markChatRead(args.chatId)
    read = r.marked
  } catch (error: any) {
    log.warn('send_file.mark_read_failed', {
      chatId: args.chatId,
      error: error?.message ?? String(error),
    })
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            messageId: result?.messageId ?? null,
            oid: result?.oid ?? null,
            fileName,
            sent: true,
            read,
          },
          null,
          2,
        ),
      },
    ],
  }
}

/**
 * Handle `send_contact` — REALLY shares a LINE contact card (contentType
 * CONTACT) to a real conversation now. Not media: it carries the shared
 * person's mid in contentMetadata. `displayName` is resolved from the mid when
 * the caller omits it. One send per call; honest error on failure.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleSendContact(
  service: LineProtocolService,
  args: { chatId: string; contactMid: string; displayName?: string },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  if (!args.contactMid) {
    return toolError('contactMid is required.')
  }

  let displayName = args.displayName ?? ''
  if (!displayName) {
    try {
      displayName = service.resolveName(args.contactMid) || ''
    } catch {
      displayName = ''
    }
    if (!displayName) {
      try {
        const contact = await service.getContact(args.contactMid)
        displayName = contact?.displayName ?? ''
      } catch {
        // Leave empty — LINE resolves the name from the mid on the recipient side.
      }
    }
  }

  const result = await service.sendContact(
    args.chatId,
    args.contactMid,
    displayName,
  )
  log.info('send_contact.sent', {
    chatId: args.chatId,
    contactMid: args.contactMid,
    messageId: result?.messageId,
  })
  let read = false
  try {
    const r = await service.markChatRead(args.chatId)
    read = r.marked
  } catch (error: any) {
    log.warn('send_contact.mark_read_failed', {
      chatId: args.chatId,
      error: error?.message ?? String(error),
    })
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            messageId: result?.messageId ?? null,
            contactMid: args.contactMid,
            displayName,
            sent: true,
            read,
          },
          null,
          2,
        ),
      },
    ],
  }
}

/**
 * Handle `send_sticker` — REALLY sends a LINE sticker to a real conversation
 * now. Not media: it names the sticker by package + id. One send per call.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleSendSticker(
  service: LineProtocolService,
  args: {
    chatId: string
    stickerId: string
    packageId: string
    version?: string
  },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  if (!args.stickerId || !args.packageId) {
    return toolError('stickerId and packageId are required.')
  }

  const result = await service.sendSticker(
    args.chatId,
    args.stickerId,
    args.packageId,
    args.version,
  )
  log.info('send_sticker.sent', {
    chatId: args.chatId,
    stickerId: args.stickerId,
    packageId: args.packageId,
    messageId: result?.messageId,
  })
  let read = false
  try {
    const r = await service.markChatRead(args.chatId)
    read = r.marked
  } catch (error: any) {
    log.warn('send_sticker.mark_read_failed', {
      chatId: args.chatId,
      error: error?.message ?? String(error),
    })
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            messageId: result?.messageId ?? null,
            stickerId: args.stickerId,
            packageId: args.packageId,
            sent: true,
            read,
          },
          null,
          2,
        ),
      },
    ],
  }
}

/**
 * Handle `send_location` — REALLY sends a location message (a map pin) to a
 * real conversation now. Not media and not E2EE: a LOCATION message carrying
 * latitude/longitude plus an optional title/address. One send per call.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleSendLocation(
  service: LineProtocolService,
  args: {
    chatId: string
    latitude: number
    longitude: number
    title?: string
    address?: string
  },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  if (
    typeof args.latitude !== 'number' ||
    typeof args.longitude !== 'number' ||
    !Number.isFinite(args.latitude) ||
    !Number.isFinite(args.longitude)
  ) {
    return toolError('latitude and longitude (finite numbers) are required.')
  }

  const result = await service.sendLocation(
    args.chatId,
    args.latitude,
    args.longitude,
    args.title,
    args.address,
  )
  log.info('send_location.sent', {
    chatId: args.chatId,
    messageId: result?.messageId,
  })
  let read = false
  try {
    const r = await service.markChatRead(args.chatId)
    read = r.marked
  } catch (error: any) {
    log.warn('send_location.mark_read_failed', {
      chatId: args.chatId,
      error: error?.message ?? String(error),
    })
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            messageId: result?.messageId ?? null,
            latitude: args.latitude,
            longitude: args.longitude,
            sent: true,
            read,
          },
          null,
          2,
        ),
      },
    ],
  }
}

/**
 * Handle `send_audio` — REALLY sends an E2EE audio message to a real
 * conversation now, via the same upload-then-send pipeline as send_file.
 * Bytes come from `filePath` or `audioBase64`; `durationMs` (when known)
 * drives the recipient's player progress bar. One send per call.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleSendAudio(
  service: LineProtocolService,
  args: {
    chatId: string
    filePath?: string
    audioBase64?: string
    fileName?: string
    durationMs?: number
  },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  const hasPath = Boolean(args.filePath)
  const hasBase64 = Boolean(args.audioBase64)
  if (hasPath === hasBase64) {
    return toolError('Provide exactly one of filePath or audioBase64.')
  }

  let audioBytes: Buffer
  let fileName: string | null = args.fileName ?? null
  if (args.filePath) {
    try {
      audioBytes = await fs.readFile(args.filePath)
    } catch (error: any) {
      return toolError(
        `Could not read filePath "${args.filePath}": ${error?.message ?? String(error)}`,
      )
    }
    fileName = fileName ?? path.basename(args.filePath)
  } else {
    audioBytes = Buffer.from(args.audioBase64 as string, 'base64')
  }

  if (audioBytes.length === 0) {
    return toolError('Resolved audio is empty.')
  }

  const result = await service.sendAudio(
    args.chatId,
    audioBytes,
    fileName,
    args.durationMs,
  )
  log.info('send_audio.sent', {
    chatId: args.chatId,
    messageId: result?.messageId,
    oid: result?.oid,
  })
  let read = false
  try {
    const r = await service.markChatRead(args.chatId)
    read = r.marked
  } catch (error: any) {
    log.warn('send_audio.mark_read_failed', {
      chatId: args.chatId,
      error: error?.message ?? String(error),
    })
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            messageId: result?.messageId ?? null,
            oid: result?.oid ?? null,
            sent: true,
            read,
          },
          null,
          2,
        ),
      },
    ],
  }
}

/**
 * Handle `send_video` — REALLY sends an E2EE video message to a real
 * conversation now, through the same upload-then-send pipeline as send_file.
 * Bytes come from `filePath` or `videoBase64`; `durationMs` (when known) drives
 * the recipient's player scrubber. The video uses LINE's chunked video E2EE
 * (per-128KB-chunk hash MAC) so it plays and verifies on official clients. One
 * send per call.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleSendVideo(
  service: LineProtocolService,
  args: {
    chatId: string
    filePath?: string
    videoBase64?: string
    fileName?: string
    durationMs?: number
  },
) {
  if (!args.chatId) {
    return toolError('chatId is required.')
  }
  const hasPath = Boolean(args.filePath)
  const hasBase64 = Boolean(args.videoBase64)
  if (hasPath === hasBase64) {
    return toolError('Provide exactly one of filePath or videoBase64.')
  }

  let videoBytes: Buffer
  let fileName: string | null = args.fileName ?? null
  if (args.filePath) {
    try {
      videoBytes = await fs.readFile(args.filePath)
    } catch (error: any) {
      return toolError(
        `Could not read filePath "${args.filePath}": ${error?.message ?? String(error)}`,
      )
    }
    fileName = fileName ?? path.basename(args.filePath)
  } else {
    videoBytes = Buffer.from(args.videoBase64 as string, 'base64')
  }

  if (videoBytes.length === 0) {
    return toolError('Resolved video is empty.')
  }

  const result = await service.sendVideo(
    args.chatId,
    videoBytes,
    fileName,
    args.durationMs,
  )
  log.info('send_video.sent', {
    chatId: args.chatId,
    messageId: result?.messageId,
    oid: result?.oid,
  })
  let read = false
  try {
    const r = await service.markChatRead(args.chatId)
    read = r.marked
  } catch (error: any) {
    log.warn('send_video.mark_read_failed', {
      chatId: args.chatId,
      error: error?.message ?? String(error),
    })
  }
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(
          {
            messageId: result?.messageId ?? null,
            oid: result?.oid ?? null,
            sent: true,
            read,
          },
          null,
          2,
        ),
      },
    ],
  }
}

/**
 * Handle `preview_sticker` — render sticker images so the caller can SEE them
 * (returns MCP image content from the public sticker CDN). With `stickerId`,
 * previews that one sticker; otherwise previews the first `limit` stickers of
 * `packageId`. Each image is preceded by a text line naming its ids so the
 * caller can map an image back to a (stickerId, packageId) for send_sticker.
 * Read-only.
 *
 * @param service - Resumed LineProtocolService (unused; CDN-only).
 * @param args - Tool arguments.
 * @returns MCP tool result with interleaved id labels and images.
 */
export async function handlePreviewSticker(
  _service: LineProtocolService,
  args: { packageId: string; stickerId?: string; limit?: number },
) {
  if (!args?.packageId) {
    return toolError('packageId is required.')
  }
  let ids: string[]
  if (args.stickerId) {
    ids = [args.stickerId]
  } else {
    const meta = await fetchStickerPackageMeta(args.packageId)
    if (!meta) {
      return toolError(
        `No sticker package found for packageId "${args.packageId}".`,
      )
    }
    ids = meta.stickerIds.slice(0, args.limit ?? 8)
  }

  const content: any[] = []
  for (const id of ids) {
    const img = await fetchStickerImage(id)
    if (!img) {
      continue
    }
    content.push({
      type: 'text' as const,
      text: `stickerId ${id} (packageId ${args.packageId}) — pass these to send_sticker`,
    })
    content.push({
      type: 'image' as const,
      data: img.toString('base64'),
      mimeType: 'image/png',
    })
  }
  if (content.length === 0) {
    return toolError('No sticker previews available for that package/sticker.')
  }
  return { content }
}

/**
 * Handle `list_stickers` — the sticker packages the account owns (and can
 * therefore send). Read-only.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleListStickers(
  service: LineProtocolService,
  args: { language?: string },
) {
  const packages = await service.listStickerPackages(args?.language)
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ total: packages.length, packages }, null, 2),
      },
    ],
  }
}

/**
 * Handle `search_stickers` — search the account's OWNED sticker packages by
 * title and expand matches into individual sticker ids ready for send_sticker.
 * Read-only.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleSearchStickers(
  service: LineProtocolService,
  args: { query: string; language?: string; limit?: number },
) {
  if (!args?.query) {
    return toolError('query is required.')
  }
  const result = await service.searchStickerPackages(
    args.query,
    args.language,
    args.limit,
  )
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
  }
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
  }))
  const content: any[] = [
    { type: 'text' as const, text: JSON.stringify(shaped, null, 2) },
  ]
  const note = phiNote(acc)
  if (note) content.push(note)
  return { content }
}

/**
 * Handle `get_message_image` — download and decrypt one image message (legacy
 * alias of get_message_media restricted to images).
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleGetMessageImage(
  service: LineProtocolService,
  args: { chatId: string; messageId: string; preview?: boolean },
) {
  if (!args.chatId || !args.messageId) {
    return toolError('chatId and messageId are required.')
  }
  try {
    const { bytes, mimeType } = await fetchLineMessageImage(
      service,
      args.chatId,
      args.messageId,
      args.preview ?? false,
    )
    return {
      content: [
        { type: 'image' as const, data: bytes.toString('base64'), mimeType },
      ],
    }
  } catch (error) {
    if (error instanceof LineMediaAccessError) {
      return toolError(error.message)
    }
    throw error
  }
}

/**
 * Handle `get_message_media` — download and decrypt any downloadable LINE
 * media message (image, video, audio, or file). Returns MCP `image`/`audio`
 * content for those kinds, or an embedded `resource` blob (with filename in
 * the URI when known) for video/file. Non-downloadable content types (plain
 * text, sticker refs, unsupported) return an honest error naming the type —
 * never fabricated bytes.
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleGetMessageMedia(
  service: LineProtocolService,
  args: { chatId: string; messageId: string; preview?: boolean },
) {
  if (!args.chatId || !args.messageId) {
    return toolError('chatId and messageId are required.')
  }
  try {
    const { bytes, contentType, fileName, mimeType } =
      await fetchLineMessageMedia(
        service,
        args.chatId,
        args.messageId,
        args.preview ?? false,
      )
    const mediaType = resolveLineMediaType(contentType)
    const data = bytes.toString('base64')
    if (mediaType === 'image') {
      return { content: [{ type: 'image' as const, data, mimeType }] }
    }
    if (mediaType === 'audio') {
      return { content: [{ type: 'audio' as const, data, mimeType }] }
    }
    const uri = `line-media://${args.chatId}/${args.messageId}${fileName ? `/${encodeURIComponent(fileName)}` : ''}`
    return {
      content: [
        { type: 'resource' as const, resource: { blob: data, mimeType, uri } },
      ],
    }
  } catch (error) {
    if (error instanceof LineMediaAccessError) {
      return toolError(error.message)
    }
    throw error
  }
}

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

/** Wrap a plain result object as a JSON MCP tool result. */
function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }
}

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
 * Handle `react_message` — REALLY adds a predefined reaction to a real LINE
 * message now (TalkService react). Visible to the conversation. `reactionType`:
 * 2=LIKE 👍, 3=LOVE ❤️, 4=LAUGH 😆, 5=SURPRISE 😮, 6=SAD 😢, 7=ANGRY 😡
 * (default 2).
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleReactMessage(
  service: LineProtocolService,
  args: { messageId: string; reactionType?: number },
) {
  if (!args.messageId) {
    return toolError('messageId is required.')
  }
  const result = await service.reactToMessage(args.messageId, args.reactionType)
  log.info('react_message.done', {
    messageId: args.messageId,
    reactionType: result?.reactionType,
  })
  return jsonResult(result)
}

/**
 * Handle `cancel_reaction` — REALLY removes THIS account's reaction from a real
 * LINE message now (TalkService cancelReaction).
 *
 * @param service - Resumed LineProtocolService.
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleCancelReaction(
  service: LineProtocolService,
  args: { messageId: string },
) {
  if (!args.messageId) {
    return toolError('messageId is required.')
  }
  const result = await service.cancelReaction(args.messageId)
  log.info('cancel_reaction.done', { messageId: args.messageId })
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
