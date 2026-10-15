import { createHash } from 'node:crypto'
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { yomiDataPath } from '../../util/data-dir.js'
import {
  computeEventId,
  decryptPayload,
  deriveJournalKey,
  encryptPayload,
  hashIdentifier,
} from './crypto.js'
import type {
  JournalIndex,
  JournalQuery,
  JournalSegmentMetadata,
  LineActivityEvent,
} from './types.js'

export interface JournalStoreOptions {
  baseDir?: string
  encryptionKey?: Buffer
  maxEventsPerSegment?: number
  maxSegmentSpanMs?: number
}

const DEFAULT_MAX_EVENTS = 500
const DEFAULT_MAX_SPAN_MS = 24 * 60 * 60 * 1000 // 24 hours

export class LineActivityJournalStore {
  private readonly baseDir: string
  private encryptionKey: Buffer | null = null
  private readonly maxEventsPerSegment: number
  private readonly maxSegmentSpanMs: number
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(options: JournalStoreOptions = {}) {
    this.baseDir = options.baseDir ?? yomiDataPath('journal')
    this.encryptionKey = options.encryptionKey ?? null
    this.maxEventsPerSegment = options.maxEventsPerSegment ?? DEFAULT_MAX_EVENTS
    this.maxSegmentSpanMs = options.maxSegmentSpanMs ?? DEFAULT_MAX_SPAN_MS
  }

  private async getKey(): Promise<Buffer> {
    if (!this.encryptionKey) {
      this.encryptionKey = await deriveJournalKey(this.baseDir)
    }
    return this.encryptionKey
  }

  private indexPath(): string {
    return join(this.baseDir, 'segments-index.json')
  }

  private segmentPath(fileName: string): string {
    return join(this.baseDir, fileName)
  }

  private async readIndex(): Promise<JournalIndex> {
    try {
      const raw = await readFile(this.indexPath(), 'utf8')
      const parsed = JSON.parse(raw) as JournalIndex
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.segments)) {
        return parsed
      }
    } catch {}
    return {
      schemaVersion: 1,
      segments: [],
      lastCompactedAt: 0,
    }
  }

  private async writeIndex(index: JournalIndex): Promise<void> {
    await mkdir(this.baseDir, { recursive: true })
    const temp = `${this.indexPath()}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, JSON.stringify(index, null, 2), { mode: 0o600 })
    await rename(temp, this.indexPath())
  }

  private async readSegmentEvents(
    meta: JournalSegmentMetadata,
  ): Promise<LineActivityEvent[]> {
    const key = await this.getKey()
    const filePath = this.segmentPath(meta.cipherFileName)
    try {
      const cipher = await readFile(filePath)
      const decrypted = decryptPayload(cipher, key)
      const lines = decrypted
        .toString('utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
      return lines.map((line) => JSON.parse(line) as LineActivityEvent)
    } catch {
      return []
    }
  }

  private async writeSegmentEvents(
    segmentId: string,
    events: LineActivityEvent[],
    completeness: 'open' | 'sealed' | 'compacted' = 'open',
  ): Promise<JournalSegmentMetadata> {
    const key = await this.getKey()
    await mkdir(this.baseDir, { recursive: true })
    const fileName = `segment-${segmentId}.enc`
    const filePath = this.segmentPath(fileName)

    const serialized = `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    const encrypted = encryptPayload(Buffer.from(serialized, 'utf8'), key)

    const temp = `${filePath}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, encrypted, { mode: 0o600 })
    await rename(temp, filePath)

    const timestamps = events.map((e) => e.sentAt)
    const chatHashes = [...new Set(events.map((e) => hashIdentifier(e.chatId)))]
    const digest = createHash('sha256').update(encrypted).digest('hex')

    return {
      segmentId,
      cipherFileName: fileName,
      minSentAt: timestamps.length ? Math.min(...timestamps) : 0,
      maxSentAt: timestamps.length ? Math.max(...timestamps) : 0,
      eventCount: events.length,
      chatIdHashes: chatHashes,
      completeness,
      sha256Digest: digest,
      byteLength: encrypted.byteLength,
    }
  }

  /**
   * Append events into the journal. Deduplicates by eventId and updates active segment.
   */
  async append(incoming: LineActivityEvent[]): Promise<void> {
    if (incoming.length === 0) return

    const run = async (): Promise<void> => {
      const index = await this.readIndex()
      let openSegmentMeta = index.segments.find(
        (s) => s.completeness === 'open',
      )
      let openEvents: LineActivityEvent[] = []

      if (openSegmentMeta) {
        openEvents = await this.readSegmentEvents(openSegmentMeta)
      } else {
        const newSegmentId = `seg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        openSegmentMeta = {
          segmentId: newSegmentId,
          cipherFileName: `segment-${newSegmentId}.enc`,
          minSentAt: 0,
          maxSentAt: 0,
          eventCount: 0,
          chatIdHashes: [],
          completeness: 'open',
          sha256Digest: '',
          byteLength: 0,
        }
      }

      const existingIds = new Set(openEvents.map((e) => e.eventId))
      const toAdd = incoming
        .map((event) => ({
          ...event,
          eventId:
            event.eventId || computeEventId(event.chatId, event.messageId),
        }))
        .filter((event) => !existingIds.has(event.eventId))

      if (toAdd.length === 0) return

      openEvents.push(...toAdd)
      openEvents.sort((a, b) => a.sentAt - b.sentAt)

      const span =
        openEvents.length > 1
          ? openEvents[openEvents.length - 1].sentAt - openEvents[0].sentAt
          : 0
      const shouldSeal =
        openEvents.length >= this.maxEventsPerSegment ||
        span >= this.maxSegmentSpanMs

      const updatedMeta = await this.writeSegmentEvents(
        openSegmentMeta.segmentId,
        openEvents,
        shouldSeal ? 'sealed' : 'open',
      )

      const segmentIndex = index.segments.findIndex(
        (s) => s.segmentId === openSegmentMeta!.segmentId,
      )
      if (segmentIndex >= 0) {
        index.segments[segmentIndex] = updatedMeta
      } else {
        index.segments.push(updatedMeta)
      }

      await this.writeIndex(index)
    }

    this.writeQueue = this.writeQueue.then(run, run)
    await this.writeQueue
  }

  /**
   * Query events matching time range, chat IDs, or limits.
   */
  async query(query: JournalQuery = {}): Promise<LineActivityEvent[]> {
    await this.writeQueue
    const index = await this.readIndex()

    const targetChatHashes = query.chatId
      ? [hashIdentifier(query.chatId)]
      : query.chatIds?.map(hashIdentifier)

    // Filter relevant segments based on metadata
    const candidateSegments = index.segments.filter((meta) => {
      if (meta.eventCount === 0) return false
      if (query.since && meta.maxSentAt < query.since) return false
      if (query.until && meta.minSentAt > query.until) return false
      if (targetChatHashes && targetChatHashes.length > 0) {
        const hasMatchingChat = targetChatHashes.some((h) =>
          meta.chatIdHashes.includes(h),
        )
        if (!hasMatchingChat) return false
      }
      return true
    })

    const matchingEvents: LineActivityEvent[] = []
    const targetChatIds = query.chatId
      ? new Set([query.chatId])
      : query.chatIds
        ? new Set(query.chatIds)
        : null

    for (const segment of candidateSegments) {
      const events = await this.readSegmentEvents(segment)
      for (const event of events) {
        if (query.since && event.sentAt < query.since) continue
        if (query.until && event.sentAt > query.until) continue
        if (targetChatIds && !targetChatIds.has(event.chatId)) continue
        matchingEvents.push(event)
      }
    }

    matchingEvents.sort((a, b) =>
      query.reverse ? b.sentAt - a.sentAt : a.sentAt - b.sentAt,
    )

    if (query.limit && query.limit > 0) {
      return matchingEvents.slice(0, query.limit)
    }
    return matchingEvents
  }

  /**
   * Immediately purge all events associated with a specific chatId from all segments.
   */
  async purgeChat(chatId: string): Promise<number> {
    let purgedCount = 0

    const run = async (): Promise<void> => {
      const index = await this.readIndex()
      const targetHash = hashIdentifier(chatId)
      const updatedSegments: JournalSegmentMetadata[] = []

      for (const meta of index.segments) {
        if (!meta.chatIdHashes.includes(targetHash)) {
          updatedSegments.push(meta)
          continue
        }

        const events = await this.readSegmentEvents(meta)
        const filtered = events.filter((e) => e.chatId !== chatId)
        purgedCount += events.length - filtered.length

        if (filtered.length === 0) {
          // Remove segment completely
          try {
            await rm(this.segmentPath(meta.cipherFileName), { force: true })
          } catch {}
        } else {
          // Rewrite segment without purged events
          const newMeta = await this.writeSegmentEvents(
            meta.segmentId,
            filtered,
            meta.completeness,
          )
          updatedSegments.push(newMeta)
        }
      }

      index.segments = updatedSegments
      await this.writeIndex(index)
    }

    this.writeQueue = this.writeQueue.then(run, run)
    await this.writeQueue
    return purgedCount
  }

  /**
   * Delete all encrypted segments and reset journal index.
   */
  async purgeAll(): Promise<void> {
    const run = async (): Promise<void> => {
      try {
        const files = await readdir(this.baseDir)
        for (const file of files) {
          await rm(join(this.baseDir, file), { recursive: true, force: true })
        }
      } catch {}
    }

    this.writeQueue = this.writeQueue.then(run, run)
    await this.writeQueue
  }

  /**
   * Compact journal by pruning segments older than retention period.
   */
  async compact(
    retentionMs = 14 * 24 * 60 * 60 * 1000,
    now = Date.now(),
  ): Promise<number> {
    let removedSegmentsCount = 0
    const cutoff = now - retentionMs

    const run = async (): Promise<void> => {
      const index = await this.readIndex()
      const keepSegments: JournalSegmentMetadata[] = []

      for (const meta of index.segments) {
        if (meta.completeness === 'sealed' && meta.maxSentAt < cutoff) {
          try {
            await rm(this.segmentPath(meta.cipherFileName), { force: true })
            removedSegmentsCount += 1
          } catch {}
        } else {
          keepSegments.push(meta)
        }
      }

      index.segments = keepSegments
      index.lastCompactedAt = now
      await this.writeIndex(index)
    }

    this.writeQueue = this.writeQueue.then(run, run)
    await this.writeQueue
    return removedSegmentsCount
  }

  async getIndex(): Promise<JournalIndex> {
    await this.writeQueue
    return this.readIndex()
  }
}
