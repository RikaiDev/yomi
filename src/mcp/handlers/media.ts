import type { LineProtocolService } from '../../line/core/service.js'
import {
  fetchLineMessageImage,
  fetchLineMessageMedia,
  LineMediaAccessError,
  resolveLineMediaType,
} from '../media.js'
import { toolError } from './shared.js'

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
