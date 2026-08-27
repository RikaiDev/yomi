import { createHash } from 'node:crypto'
import { inferAmbientEventGraph } from './ambient-event-graph.js'
import type { LineActivityEvent } from './journal/types.js'

export type AmbientObservationStatus = 'candidate'

export interface AmbientObservationEvidence {
  messageId: string
  chatId: string
  senderName: string | null
  sentAt: number
  text: string | null
  mediaType: string | null
  fileName?: string | null
  ocrEligible: boolean
  isSelf?: boolean
  mentionsSelf?: boolean
  sourceUrl?: string | null
}

export interface AmbientObservation {
  id: string
  chatId: string
  chatName: string
  topic: string
  title: string
  startedAt: number
  updatedAt: number
  confidence: number
  status: AmbientObservationStatus
  ownerHints: string[]
  relevance: 'self' | 'other' | 'unassigned'
  responseState: 'waiting' | 'received' | 'observing'
  reasons: string[]
  evidence: AmbientObservationEvidence[]
}

export interface AmbientObservationReport {
  engineVersion: number
  generatedAt: number
  windowStart: number
  coverageLimited: boolean
  chatsScanned: number
  messagesScanned: number
  officialChatsSkipped: number
  candidates: AmbientObservation[]
}

export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const EPISODE_GAP_MS = 45 * 60 * 1000
const MEDIA_ATTACH_GAP_MS = 5 * 60 * 1000
const STICKER_RESPONSE_GAP_MS = 30 * 60 * 1000
const SEMANTIC_THRESHOLD = 0.58

export type WorkingEvidence = AmbientObservationEvidence & {
  mentionNames?: string[]
  vector?: number[]
}

export function toWorkingEvidence(event: LineActivityEvent): WorkingEvidence {
  return {
    messageId: event.messageId,
    chatId: event.chatId,
    senderName: event.senderName,
    sentAt: event.sentAt,
    text: event.text,
    mediaType: event.contentType,
    fileName: event.metadata.fileName ?? null,
    ocrEligible: event.ocrEligible,
    isSelf: event.isSelf,
    mentionsSelf: event.mentionsSelf,
    sourceUrl: event.metadata.sourceUrl ?? null,
    mentionNames: event.metadata.mentionNames,
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let aa = 0
  let bb = 0
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index]
    aa += a[index] * a[index]
    bb += b[index] * b[index]
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0
}

function observationId(chatId: string, firstMessageId: string): string {
  return createHash('sha256')
    .update(`${chatId}\0${firstMessageId}`)
    .digest('hex')
    .slice(0, 20)
}

function titleFor(evidence: AmbientObservationEvidence[]): string {
  const text = evidence
    .find((item) => item.text)
    ?.text?.replace(/\s+/g, ' ')
    .trim()
  if (text) return text.slice(0, 72)
  return ''
}

function semanticClusters(rows: WorkingEvidence[]): WorkingEvidence[][] {
  const clusters: Array<{
    rows: WorkingEvidence[]
    centroid?: number[]
    vectorCount: number
  }> = []

  for (const row of rows) {
    if (!row.vector) {
      if (row.mediaType === 'sticker' && row.isSelf !== true) {
        const questionCluster = [...clusters].reverse().find((cluster) => {
          const last = cluster.rows[cluster.rows.length - 1]
          return (
            row.sentAt - last.sentAt <= STICKER_RESPONSE_GAP_MS &&
            cluster.rows.some(
              (item) => item.isSelf === true && /[?？]/.test(item.text ?? ''),
            )
          )
        })
        if (questionCluster) {
          questionCluster.rows.push(row)
          continue
        }
        const handoffCluster = [...clusters].reverse().find((cluster) => {
          const last = cluster.rows[cluster.rows.length - 1]
          return (
            row.sentAt - last.sentAt <= STICKER_RESPONSE_GAP_MS &&
            cluster.rows.some(
              (item) =>
                ['image', 'video', 'file'].includes(item.mediaType ?? '') &&
                item.senderName !== row.senderName,
            )
          )
        })
        if (handoffCluster) {
          handoffCluster.rows.push(row)
          continue
        }
      }
      const nearest = [...clusters]
        .reverse()
        .find(
          (cluster) =>
            row.sentAt - cluster.rows[cluster.rows.length - 1].sentAt <=
            MEDIA_ATTACH_GAP_MS,
        )
      if (nearest) nearest.rows.push(row)
      else clusters.push({ rows: [row], vectorCount: 0 })
      continue
    }

    let best: (typeof clusters)[number] | undefined
    let bestScore = -1
    for (const cluster of clusters) {
      if (!cluster.centroid) continue
      const score = cosine(row.vector, cluster.centroid)
      if (score > bestScore) {
        bestScore = score
        best = cluster
      }
    }
    if (!best || bestScore < SEMANTIC_THRESHOLD) {
      clusters.push({ rows: [row], centroid: [...row.vector], vectorCount: 1 })
      continue
    }
    best.rows.push(row)
    const count = best.vectorCount + 1
    best.centroid = best.centroid?.map(
      (value, index) =>
        (value * best!.vectorCount + row.vector![index]) / count,
    )
    best.vectorCount = count
  }
  return clusters.map((cluster) => cluster.rows)
}

export function reduceAmbientObservations(
  inputRows: (WorkingEvidence | LineActivityEvent)[],
  chatNames: Map<string, string>,
  now = Date.now(),
  requestedWindowStart = now - MAX_LOOKBACK_MS,
): AmbientObservationReport {
  const rows: WorkingEvidence[] = inputRows.map((r) =>
    'eventId' in r ? toWorkingEvidence(r) : r,
  )

  const windowStart = Math.max(requestedWindowStart, now - MAX_LOOKBACK_MS)
  const groups = new Map<string, WorkingEvidence[]>()
  for (const row of rows.filter((item) => item.sentAt >= windowStart)) {
    const values = groups.get(row.chatId) ?? []
    values.push(row)
    groups.set(row.chatId, values)
  }

  const candidates: AmbientObservation[] = []
  for (const [chatId, unsorted] of groups) {
    const sorted = [...unsorted].sort((a, b) => a.sentAt - b.sentAt)
    let episode: typeof sorted = []
    const flush = (): void => {
      if (episode.length === 0) return
      for (const cluster of semanticClusters(episode)) {
        const imageCount = cluster.filter(
          (item) => item.mediaType === 'image',
        ).length
        const ownerHints = [
          ...new Set(cluster.flatMap((item) => item.mentionNames ?? [])),
        ]
        const hasQuestionMark = cluster.some((item) =>
          /[?？]/.test(item.text ?? ''),
        )
        const outboundQuestion = cluster.some(
          (item) => item.isSelf === true && /[?？]/.test(item.text ?? ''),
        )
        const inboundDirectQuestion =
          chatId.startsWith('u') &&
          cluster.some(
            (item) => item.isSelf !== true && /[?？]/.test(item.text ?? ''),
          )
        const outboundQuestionIndex = cluster.findIndex(
          (item) => item.isSelf === true && /[?？]/.test(item.text ?? ''),
        )
        const receivedResponse =
          outboundQuestionIndex >= 0 &&
          cluster
            .slice(outboundQuestionIndex + 1)
            .some((item) => item.isSelf !== true)
        const mediaIndex = cluster.findIndex((item) =>
          ['image', 'video', 'file'].includes(item.mediaType ?? ''),
        )
        const mediaHandoff =
          mediaIndex >= 0 &&
          cluster
            .slice(mediaIndex + 1)
            .some((item) => item.senderName !== cluster[mediaIndex].senderName)
        const selfMediaHandoff =
          mediaIndex >= 0 &&
          cluster[mediaIndex].isSelf === true &&
          cluster.slice(mediaIndex + 1).some((item) => item.isSelf !== true)
        const directedResponse =
          cluster.length >= 2 &&
          (ownerHints.length > 0 || hasQuestionMark) &&
          cluster
            .slice(1)
            .some((item) => item.senderName !== cluster[0].senderName)
        const mentionsSelf = cluster.some((item) => item.mentionsSelf === true)
        const senders = new Set(
          cluster.map((item) => item.senderName).filter(Boolean),
        )
        const vectorRows = cluster.filter((item) => item.vector)
        const coherence =
          vectorRows.length >= 2
            ? vectorRows
                .slice(1)
                .reduce(
                  (sum, item, index) =>
                    sum + cosine(vectorRows[index].vector!, item.vector!),
                  0,
                ) /
              (vectorRows.length - 1)
            : 0

        const reasons = [
          ...(cluster.length >= 3 ? ['message_burst'] : []),
          ...(imageCount >= 3 ? ['media_burst'] : []),
          ...(ownerHints.length > 0 ? ['explicit_mention'] : []),
          ...(mentionsSelf ? ['mentions_self'] : []),
          ...(hasQuestionMark ? ['question_mark'] : []),
          ...(outboundQuestion ? ['outbound_question'] : []),
          ...(inboundDirectQuestion ? ['direct_message_question'] : []),
          ...(receivedResponse ? ['response_received'] : []),
          ...(mediaHandoff ? ['media_handoff'] : []),
          ...(directedResponse ? ['directed_response'] : []),
          ...(senders.size >= 2 ? ['multi_party'] : []),
          ...(coherence >= 0.65 ? ['semantic_coherence'] : []),
        ]

        const qualifies =
          mentionsSelf ||
          outboundQuestion ||
          inboundDirectQuestion ||
          selfMediaHandoff ||
          (vectorRows.length >= 2 && coherence >= 0.72)
        if (!qualifies) continue

        const startedAt = cluster[0].sentAt
        const updatedAt = cluster[cluster.length - 1].sentAt
        const confidence = Math.min(
          0.92,
          0.3 +
            Math.min(0.18, cluster.length * 0.03) +
            (imageCount >= 3 ? 0.14 : 0) +
            (mediaHandoff ? 0.12 : 0) +
            (inboundDirectQuestion ? 0.12 : 0) +
            (mentionsSelf ? 0.16 : ownerHints.length > 0 ? 0.04 : 0) +
            (senders.size >= 2 ? 0.08 : 0) +
            coherence * 0.18,
        )

        candidates.push({
          id: observationId(chatId, cluster[0].messageId),
          chatId,
          chatName: chatNames.get(chatId) ?? 'LINE conversation',
          topic: 'unclassified',
          title: titleFor(cluster),
          startedAt,
          updatedAt,
          confidence: Number(confidence.toFixed(2)),
          status: 'candidate',
          ownerHints,
          relevance:
            mentionsSelf || outboundQuestion || inboundDirectQuestion
              ? 'self'
              : ownerHints.length > 0 ||
                  (mediaHandoff &&
                    !cluster.some((item) => item.isSelf === true))
                ? 'other'
                : 'unassigned',
          responseState:
            receivedResponse || mediaHandoff || directedResponse
              ? 'received'
              : outboundQuestion || inboundDirectQuestion
                ? 'waiting'
                : 'observing',
          reasons,
          evidence: cluster
            .slice(-20)
            .map(
              ({ mentionNames: _mentions, vector: _vector, ...item }) => item,
            ),
        })
      }
      episode = []
    }

    for (const row of sorted) {
      if (
        episode.length > 0 &&
        row.sentAt - episode[episode.length - 1].sentAt > EPISODE_GAP_MS
      ) {
        flush()
      }
      episode.push(row)
    }
    flush()
  }

  const candidateMessageIds = new Set(
    candidates.flatMap((candidate) =>
      candidate.evidence.map((item) => item.messageId),
    ),
  )

  for (const row of rows.filter(
    (item) =>
      item.mediaType === 'file' && !candidateMessageIds.has(item.messageId),
  )) {
    const target = candidates
      .filter(
        (candidate) =>
          candidate.chatId === row.chatId &&
          row.sentAt >= candidate.startedAt &&
          row.sentAt - candidate.updatedAt <= 48 * 60 * 60 * 1000,
      )
      .filter((candidate) =>
        candidate.evidence.some((item) =>
          /請|麻煩|協助|撰寫|繳交|進度|報告|提供/.test(item.text ?? ''),
        ),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    if (!target) continue
    const { mentionNames: _mentionNames, vector: _vector, ...evidence } = row
    target.evidence.push(evidence)
    target.updatedAt = Math.max(target.updatedAt, row.sentAt)
    target.responseState = 'received'
    target.reasons.push('file_delivery')
    candidateMessageIds.add(row.messageId)
  }

  const graph = inferAmbientEventGraph(rows)
  const rowByID = new Map(rows.map((row) => [row.messageId, row]))

  for (const candidate of candidates) {
    if (candidate.responseState === 'received') continue
    const trigger = rowByID.get(candidate.evidence[0]?.messageId)
    if (!trigger) continue
    const descendantIDs = graph.descendants([trigger.messageId])
    const responseRows = [...descendantIDs]
      .map((id) => rowByID.get(id))
      .filter((row): row is WorkingEvidence => Boolean(row))
      .sort((a, b) => a.sentAt - b.sentAt)
    const inboundDirectQuestion =
      trigger.chatId.startsWith('u') &&
      trigger.isSelf !== true &&
      /[?？]/.test(trigger.text ?? '')
    const outboundQuestion =
      trigger.isSelf === true && /[?？]/.test(trigger.text ?? '')
    const response = responseRows.find((row) => {
      if (inboundDirectQuestion || trigger.mentionsSelf)
        return row.isSelf === true
      if (outboundQuestion) return row.isSelf !== true
      return (
        row.senderName !== null && candidate.ownerHints.includes(row.senderName)
      )
    })
    if (!response) continue
    const existingIDs = new Set(
      candidate.evidence.map((item) => item.messageId),
    )
    candidate.evidence.push(
      ...responseRows
        .filter((row) => !existingIDs.has(row.messageId))
        .slice(0, 6)
        .map(({ mentionNames: _mentions, vector: _vector, ...row }) => row),
    )
    candidate.updatedAt = Math.max(
      candidate.updatedAt,
      ...responseRows.map((row) => row.sentAt),
    )
    candidate.responseState = 'received'
    candidate.reasons.push('graph_response_received')
  }

  const relevanceRank = { self: 0, unassigned: 1, other: 2 }
  const actionRank = (candidate: AmbientObservation): number =>
    candidate.responseState === 'received'
      ? 3
      : relevanceRank[candidate.relevance]

  candidates.sort(
    (a, b) =>
      actionRank(a) - actionRank(b) ||
      b.updatedAt - a.updatedAt ||
      b.confidence - a.confidence,
  )

  return {
    engineVersion: 15,
    generatedAt: now,
    windowStart,
    coverageLimited: false,
    chatsScanned: new Set(rows.map((row) => row.chatId)).size,
    messagesScanned: rows.length,
    officialChatsSkipped: 0,
    candidates: candidates.slice(0, 24),
  }
}
