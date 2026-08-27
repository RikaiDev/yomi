import { createHash } from 'node:crypto'
import type { WorkItemAdapter, WorkItemAdapterResult } from './adapter.js'
import type {
  WorkItemAttachment,
  WorkItemEvidence,
  WorkItemSourceRef,
} from './types.js'

export type LineWorkItemInput =
  | LineWorkItemMessageInput
  | readonly LineWorkItemMessageInput[]

export interface LineWorkItemAttachmentInput {
  id?: string | number
  fileName?: string | null
  mimeType?: string | null
  mediaType?: string | null
  byteLength?: number | null
  size?: number | null
  bytes?: Uint8Array | ArrayBuffer
  url?: string | null
  mediaUrl?: string | null
}

/** The adapter accepts the desktop/CLI projection, not LINE protocol objects. */
export interface LineWorkItemMessageInput {
  id: string | number
  chatId?: string | number | null
  conversationId?: string | number | null
  fromMid?: string | null
  senderId?: string | null
  fromName?: string | null
  senderName?: string | null
  timestamp?: number | null
  text?: string | null
  content?: string | null
  attachments?: LineWorkItemAttachmentInput[]
  attachment?: LineWorkItemAttachmentInput | null
  mediaUrl?: string | null
  fileName?: string | null
  mediaType?: string | null
  contentType?: number | null
}

function asBytes(
  bytes: Uint8Array | ArrayBuffer | undefined,
): Uint8Array | undefined {
  if (!bytes) return undefined
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

function normalizeAttachment(
  input: LineWorkItemAttachmentInput,
  messageId: string,
  index: number,
): WorkItemAttachment {
  const bytes = asBytes(input.bytes)
  return {
    id: String(input.id ?? `${messageId}:attachment:${index}`),
    fileName: input.fileName ?? null,
    mimeType: input.mimeType ?? input.mediaType ?? null,
    byteLength: input.byteLength ?? input.size ?? bytes?.byteLength ?? null,
    sha256: bytes ? createHash('sha256').update(bytes).digest('hex') : null,
    ...(bytes ? { bytes } : {}),
    ...(input.url || input.mediaUrl
      ? { sourceUrl: input.url ?? input.mediaUrl ?? undefined }
      : {}),
  }
}

function messageAttachments(
  input: LineWorkItemMessageInput,
  messageId: string,
): WorkItemAttachment[] {
  const values = [
    ...(input.attachments ?? []),
    ...(input.attachment ? [input.attachment] : []),
  ]
  if (values.length === 0 && (input.mediaUrl || input.fileName)) {
    values.push({
      fileName: input.fileName,
      mediaType: input.mediaType,
      mediaUrl: input.mediaUrl,
    })
  }
  return values.map((item, index) =>
    normalizeAttachment(item, messageId, index),
  )
}

export function isLineWorkItemMessage(
  input: unknown,
): input is LineWorkItemMessageInput {
  return (
    typeof input === 'object' &&
    input !== null &&
    (typeof (input as { id?: unknown }).id === 'string' ||
      typeof (input as { id?: unknown }).id === 'number')
  )
}

export class LineWorkItemAdapter implements WorkItemAdapter<LineWorkItemInput> {
  readonly id = 'line.message'
  readonly platform = 'line'

  canNormalize(input: unknown): input is LineWorkItemInput {
    return (
      isLineWorkItemMessage(input) ||
      (Array.isArray(input) && input.every(isLineWorkItemMessage))
    )
  }

  normalize(input: LineWorkItemInput): WorkItemAdapterResult {
    const inputs = Array.isArray(input) ? [...input] : [input]
    if (inputs.length === 0)
      throw new Error('LINE work item requires at least one message')
    const normalized = inputs.map((message) => {
      const messageId = String(message.id)
      const conversationId = String(
        message.conversationId ?? message.chatId ?? '',
      )
      if (!conversationId)
        throw new Error('LINE work item requires conversationId')
      const sentAt = message.timestamp ?? Date.now()
      const source: WorkItemSourceRef = {
        adapter: this.id,
        platform: this.platform,
        conversationId,
        messageIds: [messageId],
        latestMessageAt: sentAt,
      }
      return {
        conversationId,
        evidence: {
          source,
          sourceMessageId: messageId,
          senderId: message.senderId ?? message.fromMid ?? null,
          senderName: message.senderName ?? message.fromName ?? null,
          sentAt,
          text: message.text ?? message.content ?? null,
          attachments: messageAttachments(message, messageId),
        } satisfies WorkItemEvidence,
      }
    })
    const seen = new Set<string>()
    const evidence = normalized
      .sort(
        (a, b) =>
          a.evidence.sentAt - b.evidence.sentAt ||
          a.evidence.sourceMessageId.localeCompare(b.evidence.sourceMessageId),
      )
      .flatMap((message) => {
        const key = `${message.conversationId}:${message.evidence.sourceMessageId}`
        if (seen.has(key)) return []
        seen.add(key)
        return [message.evidence]
      })
    const sourceByConversation = new Map<string, WorkItemSourceRef>()
    for (const item of evidence) {
      const itemSource = item.source
      const existing = sourceByConversation.get(itemSource.conversationId)
      if (existing) {
        existing.messageIds.push(...itemSource.messageIds)
        existing.latestMessageAt = Math.max(
          existing.latestMessageAt,
          itemSource.latestMessageAt,
        )
      } else {
        sourceByConversation.set(itemSource.conversationId, {
          ...itemSource,
          messageIds: [...itemSource.messageIds],
        })
      }
    }
    const sources = [...sourceByConversation.values()]
    return {
      source: sources[0],
      sources,
      evidence,
    }
  }
}
