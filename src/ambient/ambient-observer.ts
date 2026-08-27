import { sanitizeMessagePreview } from '../line/core/message-preview.js'
import { LineProtocolService } from '../line/core/service.js'
import {
  type AmbientObservation,
  type AmbientObservationEvidence,
  type AmbientObservationReport,
  type AmbientObservationStatus,
  MAX_LOOKBACK_MS,
  reduceAmbientObservations,
  type WorkingEvidence,
} from './event-graph-reducer.js'
import { LineIngestionAdapter } from './ingestion-adapter.js'

export type {
  AmbientObservation,
  AmbientObservationEvidence,
  AmbientObservationReport,
  AmbientObservationStatus,
}

function mediaType(contentType: number): string | null {
  return (
    (
      {
        1: 'image',
        2: 'video',
        3: 'audio',
        7: 'sticker',
        14: 'file',
      } as Record<number, string>
    )[contentType] ?? null
  )
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

export function normalizeSquareObservationRows(
  chat: { id: string; memberMid?: string | null },
  messages: any[],
): WorkingEvidence[] {
  const senderNames = new Map<string, string>(
    messages
      .filter((message) => message?.fromMid && message?.fromName)
      .map((message) => [String(message.fromMid), String(message.fromName)]),
  )
  return messages.map((message) => {
    const type = mediaType(Number(message.contentType ?? 0))
    const mentions = mentionMids(message.contentMetadata)
    return {
      messageId: String(message.id),
      chatId: chat.id,
      senderName: message.fromName ? String(message.fromName) : null,
      sentAt: Number(message.createdTime ?? 0),
      text: sanitizeMessagePreview(message.text) || null,
      mediaType: type,
      fileName: message.fileName ? String(message.fileName) : null,
      ocrEligible: true,
      isSelf: message.isSelf === true,
      mentionsSelf: Boolean(
        chat.memberMid && mentions.includes(String(chat.memberMid)),
      ),
      sourceUrl:
        type === 'sticker' && message.contentMetadata?.STKID
          ? `https://stickershop.line-scdn.net/stickershop/v1/sticker/${message.contentMetadata.STKID}/android/sticker.png`
          : null,
      mentionNames: mentions
        .map((mid) => senderNames.get(mid))
        .filter((name): name is string => Boolean(name)),
    }
  })
}

export function buildAmbientObservations(
  rows: WorkingEvidence[],
  chatNames: Map<string, string>,
  now = Date.now(),
  requestedWindowStart = now - MAX_LOOKBACK_MS,
): AmbientObservationReport {
  return reduceAmbientObservations(rows, chatNames, now, requestedWindowStart)
}

export async function scanAmbientObservations(
  requestedWindowStart?: number,
  now = Date.now(),
): Promise<AmbientObservationReport> {
  const service = new LineProtocolService()
  if (!(await service.resumeSession()))
    throw new Error('LINE session unavailable')

  const windowStart = Math.max(
    requestedWindowStart ?? now - MAX_LOOKBACK_MS,
    now - MAX_LOOKBACK_MS,
  )

  const adapter = new LineIngestionAdapter(service)
  const ingestion = await adapter.collectRecentEvents({ windowStart })

  const report = reduceAmbientObservations(
    ingestion.events,
    ingestion.chatNames,
    now,
    windowStart,
  )
  report.coverageLimited = ingestion.coverageLimited
  report.chatsScanned = ingestion.chatsScanned
  report.messagesScanned = ingestion.messagesScanned
  report.officialChatsSkipped = ingestion.officialChatsSkipped

  return report
}
