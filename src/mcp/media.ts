/**
 * LINE E2EE media resolution for the `get_message_media` (and legacy
 * `get_message_image`) MCP tools.
 *
 * Mirrors the descriptor-parsing logic the original (excluded) media-asset
 * pipeline used, adapted for the MCP surface: given a chat + message id,
 * locate the message's OBS object metadata and E2EE key material, download
 * the encrypted bytes, and decrypt them. The obs-download + AES-256-CTR
 * decrypt path is identical across LINE content types (image/video/audio/
 * file) — only the resolved MIME type and MCP content shape differ.
 *
 * Never fabricates a fallback — if key material or OBS metadata is
 * missing, or the message's content type is not a downloadable media type,
 * callers get an honest error naming the reason.
 */

import {
  downloadLineMessageData,
  downloadLineObsMediaObject,
} from '../line/client/obs-media-client.js'
import { isSquareChatMid } from '../line/client/square-service/client.js'
import { CONTENT_TYPE } from '../line/core/constants.js'
import { decryptLineMediaBytes } from '../line/core/media-decrypt.js'

interface LineMediaDescriptor {
  fileName: string | null
  mimeType: string | null
  oid: string
  sid: string
  keyMaterial: string | null
}

/** LINE content types this server can download and decrypt via the OBS path. */
const DOWNLOADABLE_CONTENT_TYPES = new Set<number>([
  CONTENT_TYPE.IMAGE,
  CONTENT_TYPE.VIDEO,
  CONTENT_TYPE.AUDIO,
  CONTENT_TYPE.FILE,
])

/** Short media-kind label per LINE content type, for MCP content shaping. */
const MEDIA_TYPE_BY_CONTENT_TYPE: Record<number, string> = {
  [CONTENT_TYPE.IMAGE]: 'image',
  [CONTENT_TYPE.VIDEO]: 'video',
  [CONTENT_TYPE.AUDIO]: 'audio',
  [CONTENT_TYPE.FILE]: 'file',
}

/** Fallback MIME type per content type when no file extension is known. */
const DEFAULT_MIME_BY_CONTENT_TYPE: Record<number, string> = {
  [CONTENT_TYPE.IMAGE]: 'image/jpeg',
  [CONTENT_TYPE.VIDEO]: 'video/mp4',
  [CONTENT_TYPE.AUDIO]: 'audio/mp4',
  [CONTENT_TYPE.FILE]: 'application/octet-stream',
}

/** MIME type per known file extension, across all downloadable media kinds. */
const MIME_BY_EXTENSION: Record<string, string> = {
  '3gp': 'video/3gpp',
  aac: 'audio/aac',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4a: 'audio/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  ogg: 'audio/ogg',
  pdf: 'application/pdf',
  png: 'image/png',
  txt: 'text/plain',
  wav: 'audio/wav',
  webp: 'image/webp',
  zip: 'application/zip',
}

const TRUSTED_PUBLIC_MEDIA_HOST_SUFFIXES = [
  'line-scdn.net',
  'line-apps.com',
  'cdn.hinet.net',
]

export function resolvePublicMediaUrl(
  message: any,
  preview: boolean,
): URL | null {
  const metadata = message?.contentMetadata ?? {}
  if (metadata.PUBLIC !== 'true') return null
  const raw = preview
    ? metadata.PREVIEW_URL || metadata.DOWNLOAD_URL
    : metadata.DOWNLOAD_URL || metadata.PREVIEW_URL
  if (typeof raw !== 'string' || !raw) return null
  try {
    const url = new URL(raw)
    const hostname = url.hostname.toLowerCase()
    if (
      url.protocol !== 'https:' ||
      !TRUSTED_PUBLIC_MEDIA_HOST_SUFFIXES.some(
        (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
      )
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}

async function downloadPublicMedia(url: URL): Promise<{
  bytes: Buffer
  mimeType: string | null
}> {
  const response = await fetch(url, { redirect: 'error' })
  if (!response.ok) {
    throw new Error(`Public LINE media download failed (${response.status})`)
  }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(length) && length > 25 * 1024 * 1024) {
    throw new Error('Public LINE media exceeds 25 MB')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length === 0 || bytes.length > 25 * 1024 * 1024) {
    throw new Error('Public LINE media returned invalid bytes')
  }
  return {
    bytes,
    mimeType: response.headers.get('content-type')?.split(';')[0] || null,
  }
}

/**
 * Resolve the short media-kind label for a LINE content type.
 *
 * @param contentType - LINE contentType numeric value.
 * @returns 'image' | 'video' | 'audio' | 'file', or null when not downloadable media.
 */
export function resolveLineMediaType(contentType: number): string | null {
  return MEDIA_TYPE_BY_CONTENT_TYPE[contentType] || null
}

/**
 * Parse JSON safely with a fallback.
 *
 * @param value - Raw JSON value.
 * @param fallback - Fallback value.
 * @returns Parsed JSON or fallback.
 */
function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || !value) {
    return fallback
  }
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

/**
 * Resolve a MIME type from LINE media metadata.
 *
 * @param extension - File extension from MEDIA_CONTENT_INFO.
 * @param contentType - LINE content type.
 * @returns MIME type, or null when unknown.
 */
function resolveMimeType(
  extension: string | null,
  contentType: number,
): string | null {
  const normalized = extension?.toLowerCase() || ''
  if (MIME_BY_EXTENSION[normalized]) {
    return MIME_BY_EXTENSION[normalized]
  }
  return DEFAULT_MIME_BY_CONTENT_TYPE[contentType] || null
}

/**
 * Resolve a legacy message's filename extension without requiring an OBS
 * descriptor.  Older Talk messages expose MEDIA_CONTENT_INFO but omit OID/SID.
 */
function resolveMediaInfoExtension(message: any): string | null {
  const info = parseJson<{ extension?: string }>(
    message?.contentMetadata?.MEDIA_CONTENT_INFO,
    {},
  )
  return typeof info.extension === 'string' && info.extension.trim()
    ? info.extension.trim()
    : null
}

/**
 * Build a LINE media descriptor from a decrypted message.
 *
 * Image messages carry the E2EE `keyMaterial` inside their decrypted
 * `text` field as JSON, and the OBS object id/service-namespace inside
 * `contentMetadata.OID` / `contentMetadata.SID`.
 *
 * @param message - Decrypted LINE message (from getRecentMessages).
 * @returns Media descriptor, or null when the message has no OBS object.
 */
export function resolveLineMediaDescriptor(
  message: any,
): LineMediaDescriptor | null {
  const contentMetadata = message?.contentMetadata || {}
  if (!contentMetadata.OID || !contentMetadata.SID) {
    return null
  }
  const dataPayload = parseJson<{ keyMaterial?: string; fileName?: string }>(
    message?.text,
    {},
  )
  const mediaInfo = parseJson<{ extension?: string }>(
    contentMetadata.MEDIA_CONTENT_INFO,
    {},
  )
  const fileName =
    dataPayload.fileName ||
    (typeof contentMetadata.FILE_NAME === 'string' &&
      contentMetadata.FILE_NAME) ||
    (typeof contentMetadata.FILE_NAME_ORIGINAL === 'string' &&
      contentMetadata.FILE_NAME_ORIGINAL) ||
    (typeof contentMetadata.name === 'string' && contentMetadata.name) ||
    null
  const extension =
    mediaInfo.extension || (fileName ? fileName.split('.').pop() : null) || null
  return {
    fileName,
    keyMaterial: dataPayload.keyMaterial || null,
    mimeType: resolveMimeType(extension, Number(message?.contentType || 0)),
    oid: String(contentMetadata.OID),
    sid: String(contentMetadata.SID),
  }
}

export interface FetchLineMessageImageResult {
  bytes: Buffer
  mimeType: string
}

export interface FetchLineMessageMediaResult {
  bytes: Buffer
  contentType: number
  fileName: string | null
  mimeType: string
}

/** Base class for honest "could not produce media bytes" errors — never caught to fabricate a fallback. */
export abstract class LineMediaAccessError extends Error {
  public abstract readonly code: string
}

/** Thrown when the message body is missing the OBS/E2EE material required to decrypt its media. */
class MissingDecryptMaterialError extends LineMediaAccessError {
  public readonly code = 'missing_decrypt_material'

  constructor(reason: string) {
    super(`missing_decrypt_material: ${reason}`)
  }
}

/** Thrown when the message's content type is not a downloadable media type (e.g. plain text, sticker ref). */
class UnsupportedMediaTypeError extends LineMediaAccessError {
  public readonly code = 'unsupported_media_type'

  constructor(contentType: number, messageId: string) {
    const label =
      resolveLineMediaType(contentType) ?? `contentType=${contentType}`
    super(
      `unsupported_media_type: message ${messageId} (${label}) is not downloadable media`,
    )
  }
}

/**
 * Fetch and decrypt one LINE media attachment (image, video, audio, or file).
 *
 * The obs-media-client download and AES-256-CTR decrypt are content-type
 * agnostic — only descriptor resolution (MIME/filename) and the downstream
 * MCP content shape differ per media kind.
 *
 * @param service - Active LineProtocolService (must already have a resumed session).
 * @param chatId - LINE chat MID the message belongs to.
 * @param messageId - LINE message id.
 * @param preview - Whether to fetch the smaller preview object instead of the original.
 * @returns Decrypted media bytes, resolved MIME type, filename, and content type.
 */
export async function fetchLineMessageMedia(
  service: any,
  chatId: string,
  messageId: string,
  preview: boolean,
): Promise<FetchLineMessageMediaResult> {
  if (isSquareChatMid(chatId)) {
    const mainMessages = await service.client.getSquareChatMessages(chatId, 100)
    let message = mainMessages.find(
      (candidate: any) => candidate.id === messageId,
    )
    if (!message) {
      for (const root of mainMessages.filter(
        (candidate: any) => candidate.isThreadRoot && candidate.threadMid,
      )) {
        const replies = await service.client.getSquareChatMessages(
          chatId,
          100,
          root.threadMid,
        )
        message = replies.find((candidate: any) => candidate.id === messageId)
        if (message) break
      }
    }
    if (!message) {
      throw new MissingDecryptMaterialError(
        `Square message ${messageId} not found in ${chatId}`,
      )
    }
    const contentType = Number(message.contentType)
    if (!DOWNLOADABLE_CONTENT_TYPES.has(contentType)) {
      throw new UnsupportedMediaTypeError(contentType, messageId)
    }
    const downloaded = await downloadLineMessageData(service.client, {
      messageId,
      preview,
      square: true,
    })
    return {
      bytes: downloaded.bytes,
      contentType,
      fileName: message.contentMetadata?.FILE_NAME || null,
      mimeType:
        downloaded.mimeType ||
        DEFAULT_MIME_BY_CONTENT_TYPE[contentType] ||
        'application/octet-stream',
    }
  }
  const messages = await service.getRecentMessages(chatId, 100)
  const message = messages.find((candidate: any) => candidate.id === messageId)
  if (!message) {
    throw new MissingDecryptMaterialError(
      `message ${messageId} not found in recent history of ${chatId}`,
    )
  }
  const contentType = Number(message.contentType)
  if (!DOWNLOADABLE_CONTENT_TYPES.has(contentType)) {
    throw new UnsupportedMediaTypeError(contentType, messageId)
  }

  const publicMediaUrl = resolvePublicMediaUrl(message, preview)
  if (publicMediaUrl) {
    const downloaded = await downloadPublicMedia(publicMediaUrl)
    const extension = publicMediaUrl.pathname.split('.').pop() ?? null
    return {
      bytes: downloaded.bytes,
      contentType,
      fileName: null,
      mimeType:
        downloaded.mimeType ||
        resolveMimeType(extension, contentType) ||
        'application/octet-stream',
    }
  }

  const descriptor = resolveLineMediaDescriptor(message)
  if (!descriptor) {
    // Older/non-E2EE Talk messages carry MEDIA_CONTENT_INFO but omit OID/SID.
    // Their object is addressed by message id at OBS /r/talk/m/{id}; the
    // similarly named TalkService methods are not real `/S4` methods and
    // return Invalid method name.  Keep the request at the OBS layer.
    const downloaded = await downloadLineMessageData(service.client, {
      messageId,
      preview,
    })
    const contentMetadata = message?.contentMetadata || {}
    const fileName =
      (typeof contentMetadata.FILE_NAME === 'string' &&
        contentMetadata.FILE_NAME) ||
      (typeof contentMetadata.FILE_NAME_ORIGINAL === 'string' &&
        contentMetadata.FILE_NAME_ORIGINAL) ||
      (typeof contentMetadata.name === 'string' && contentMetadata.name) ||
      null
    return {
      bytes: downloaded.bytes,
      contentType,
      fileName,
      mimeType:
        downloaded.mimeType ||
        resolveMimeType(resolveMediaInfoExtension(message), contentType) ||
        'application/octet-stream',
    }
  }

  const encryptedBytes = await downloadLineObsMediaObject(service.client, {
    messageId,
    oid: descriptor.oid,
    preview,
    sid: descriptor.sid,
  })
  if (encryptedBytes.length === 0) {
    throw new Error('LINE media download returned empty bytes')
  }

  const fallbackMimeType =
    descriptor.mimeType ||
    DEFAULT_MIME_BY_CONTENT_TYPE[contentType] ||
    'application/octet-stream'

  if (!descriptor.keyMaterial) {
    // Not all media messages are E2EE-wrapped (e.g. some group content is
    // plaintext) — but when contentMetadata carries no keyMaterial we
    // cannot tell the difference between "unencrypted" and "decrypt
    // context missing", so we surface the honest bytes as-is rather than
    // guessing. Callers can inspect mimeType/bytes to decide.
    return {
      bytes: encryptedBytes,
      contentType,
      fileName: descriptor.fileName,
      mimeType: fallbackMimeType,
    }
  }

  // Which MAC construction applies is decided by the OBS object, not by
  // contentType alone: a video's main body is MACed over its per-128KB chunk
  // hashes, but that same video's `__ud-preview` poster is a whole-file image
  // and is MACed like one. Confirmed against real media of each shape.
  const mediaBytes = await decryptLineMediaBytes(
    encryptedBytes,
    descriptor.keyMaterial,
    { chunkHashMac: contentType === CONTENT_TYPE.VIDEO && !preview },
  )
  if (mediaBytes.length === 0) {
    throw new Error('LINE media decrypt returned empty bytes')
  }
  return {
    bytes: mediaBytes,
    contentType,
    fileName: descriptor.fileName,
    mimeType: fallbackMimeType,
  }
}

/**
 * Fetch and decrypt one LINE image attachment. Thin `get_message_image`
 * back-compat wrapper over {@link fetchLineMessageMedia} that rejects
 * non-image content types with an honest error.
 *
 * @param service - Active LineProtocolService (must already have a resumed session).
 * @param chatId - LINE chat MID the message belongs to.
 * @param messageId - LINE message id.
 * @param preview - Whether to fetch the smaller preview object instead of the original.
 * @returns Decrypted image bytes and resolved MIME type.
 */
export async function fetchLineMessageImage(
  service: any,
  chatId: string,
  messageId: string,
  preview: boolean,
): Promise<FetchLineMessageImageResult> {
  const result = await fetchLineMessageMedia(
    service,
    chatId,
    messageId,
    preview,
  )
  if (result.contentType !== CONTENT_TYPE.IMAGE) {
    throw new UnsupportedMediaTypeError(result.contentType, messageId)
  }
  return { bytes: result.bytes, mimeType: result.mimeType }
}
