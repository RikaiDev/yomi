import fs from 'node:fs/promises'
import path from 'node:path'
import { buildMentionMetadata, type Mention } from '../../line/core/mention.js'
import type { LineProtocolService } from '../../line/core/service.js'
import { createCliLogger } from '../../util/log.js'
import { toolError } from './shared.js'

const log = createCliLogger('Yomi')

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
