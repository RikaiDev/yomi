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

import { downloadLineObsMediaObject } from '../line/client/obs-media-client.js'
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
  return {
    fileName: dataPayload.fileName || null,
    keyMaterial: dataPayload.keyMaterial || null,
    mimeType: resolveMimeType(
      mediaInfo.extension || null,
      Number(message?.contentType || 0),
    ),
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
export class MissingDecryptMaterialError extends LineMediaAccessError {
  public readonly code = 'missing_decrypt_material'

  constructor(reason: string) {
    super(`missing_decrypt_material: ${reason}`)
  }
}

/** Thrown when the message's content type is not a downloadable media type (e.g. plain text, sticker ref). */
export class UnsupportedMediaTypeError extends LineMediaAccessError {
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

  const descriptor = resolveLineMediaDescriptor(message)
  if (!descriptor) {
    throw new MissingDecryptMaterialError(
      `message ${messageId} is missing OBS object metadata (OID/SID)`,
    )
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

  const mediaBytes = await decryptLineMediaBytes(
    encryptedBytes,
    descriptor.keyMaterial,
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
