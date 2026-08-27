/**
 * Types for the encrypted append-only LineActivityEvent journal.
 *
 * LineActivityEvent is the immutable unit of observation recorded from LINE sync
 * operations, TalkService message boxes, and SquareService channels.
 */

export type LineContentType =
  | 'text'
  | 'image'
  | 'video'
  | 'audio'
  | 'sticker'
  | 'file'
  | 'call'
  | 'flex'
  | 'system'

export interface LineActivityMetadata {
  mentionMids?: string[]
  mentionNames?: string[]
  stickerId?: string
  packageId?: string
  fileName?: string
  fileSize?: number
  flexTitle?: string
  sourceUrl?: string | null
}

export interface LineActivityEvent {
  /** Deterministic event identifier: sha256(chatId + '\0' + messageId).slice(0, 24) */
  eventId: string
  /** Conversation ID (Direct u-mid, Group c-mid, Square m-mid) */
  chatId: string
  /** LINE Talk / Square message identifier */
  messageId: string
  /** Sync operation revision or sequence number for monotonic ordering */
  opRevision: number | null
  /** Sender identity (MID) */
  senderMid: string | null
  /** Display name at time of event */
  senderName: string | null
  /** Delivered / Created timestamp in milliseconds */
  sentAt: number
  /** Normalized content classification */
  contentType: LineContentType
  /** Sanitized text preview (E2EE envelopes sanitized, sensitive tokens masked) */
  text: string | null
  /** Structured metadata */
  metadata: LineActivityMetadata
  /** Direct user involvement flags */
  isSelf: boolean
  mentionsSelf: boolean
  /** OCR eligibility: only candidate attachments are eligible; promotional broadcasts excluded */
  ocrEligible: boolean
}

export interface JournalSegmentMetadata {
  segmentId: string
  cipherFileName: string
  minSentAt: number
  maxSentAt: number
  eventCount: number
  chatIdHashes: string[]
  completeness: 'open' | 'sealed' | 'compacted'
  sha256Digest: string
  byteLength: number
}

export interface JournalIndex {
  schemaVersion: 1
  segments: JournalSegmentMetadata[]
  lastCompactedAt: number
}

export interface JournalQuery {
  chatId?: string
  chatIds?: string[]
  since?: number
  until?: number
  limit?: number
  reverse?: boolean
}
