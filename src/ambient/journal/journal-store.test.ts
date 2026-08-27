import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveJournalKey } from './crypto.js'
import { LineActivityJournalStore } from './journal-store.js'
import type { LineActivityEvent } from './types.js'

let tempDir: string
let store: LineActivityJournalStore

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'yomi-journal-test-'))
  const key = await deriveJournalKey('test-journal')
  store = new LineActivityJournalStore({
    baseDir: tempDir,
    encryptionKey: key,
    maxEventsPerSegment: 3, // low threshold for testing rotation
  })
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function makeEvent(
  id: string,
  chatId: string,
  sentAt: number,
  text: string,
  extra: Partial<LineActivityEvent> = {},
): LineActivityEvent {
  return {
    eventId: `evt-${id}`,
    chatId,
    messageId: id,
    opRevision: null,
    senderMid: 'u-sender',
    senderName: 'Sender',
    sentAt,
    contentType: 'text',
    text,
    metadata: {},
    isSelf: false,
    mentionsSelf: false,
    ocrEligible: false,
    ...extra,
  }
}

test('appends events and retrieves them through query', async () => {
  const e1 = makeEvent('1', 'chat-a', 1000, 'Hello')
  const e2 = makeEvent('2', 'chat-a', 2000, 'World')

  await store.append([e1, e2])

  const results = await store.query()
  expect(results).toHaveLength(2)
  expect(results[0].text).toBe('Hello')
  expect(results[1].text).toBe('World')
})

test('deduplicates events by eventId', async () => {
  const e1 = makeEvent('1', 'chat-a', 1000, 'Hello')

  await store.append([e1])
  await store.append([e1])

  const results = await store.query()
  expect(results).toHaveLength(1)
})

test('rotates segments when maxEventsPerSegment is reached', async () => {
  const e1 = makeEvent('1', 'chat-a', 1000, 'One')
  const e2 = makeEvent('2', 'chat-a', 2000, 'Two')
  const e3 = makeEvent('3', 'chat-a', 3000, 'Three')
  const e4 = makeEvent('4', 'chat-a', 4000, 'Four')

  await store.append([e1, e2, e3])
  await store.append([e4])

  const index = await store.getIndex()
  expect(index.segments.length).toBe(2)
  expect(index.segments[0].completeness).toBe('sealed')
  expect(index.segments[1].completeness).toBe('open')

  const results = await store.query()
  expect(results).toHaveLength(4)
})

test('queries with time bounds and chatId filtering', async () => {
  const e1 = makeEvent('1', 'chat-a', 1000, 'Msg A1')
  const e2 = makeEvent('2', 'chat-b', 2000, 'Msg B1')
  const e3 = makeEvent('3', 'chat-a', 3000, 'Msg A2')
  const e4 = makeEvent('4', 'chat-b', 4000, 'Msg B2')

  await store.append([e1, e2, e3, e4])

  const chatAResults = await store.query({ chatId: 'chat-a' })
  expect(chatAResults).toHaveLength(2)
  expect(chatAResults.map((e) => e.messageId)).toEqual(['1', '3'])

  const timeResults = await store.query({ since: 1500, until: 3500 })
  expect(timeResults).toHaveLength(2)
  expect(timeResults.map((e) => e.messageId)).toEqual(['2', '3'])
})

test('purgeChat removes all events for that chat', async () => {
  const e1 = makeEvent('1', 'chat-to-delete', 1000, 'Sensitive')
  const e2 = makeEvent('2', 'chat-keep', 2000, 'Keep this')
  const e3 = makeEvent('3', 'chat-to-delete', 3000, 'Also sensitive')

  await store.append([e1, e2, e3])

  const purged = await store.purgeChat('chat-to-delete')
  expect(purged).toBe(2)

  const remaining = await store.query()
  expect(remaining).toHaveLength(1)
  expect(remaining[0].chatId).toBe('chat-keep')
})

test('purgeAll deletes everything', async () => {
  const e1 = makeEvent('1', 'chat-a', 1000, 'A')
  const e2 = makeEvent('2', 'chat-b', 2000, 'B')

  await store.append([e1, e2])
  await store.purgeAll()

  const remaining = await store.query()
  expect(remaining).toHaveLength(0)
})

test('compact prunes sealed segments older than retention', async () => {
  const oldTime = 100_000
  const e1 = makeEvent('1', 'chat-a', oldTime + 1, 'Old 1')
  const e2 = makeEvent('2', 'chat-a', oldTime + 2, 'Old 2')
  const e3 = makeEvent('3', 'chat-a', oldTime + 3, 'Old 3') // seals segment

  const newTime = 500_000
  const e4 = makeEvent('4', 'chat-a', newTime + 1, 'New 1')

  await store.append([e1, e2, e3])
  await store.append([e4])

  const indexBefore = await store.getIndex()
  expect(indexBefore.segments.length).toBe(2)

  // Retention is 100_000, current time is 500_000 -> cutoff is 400_000
  const removed = await store.compact(100_000, newTime)
  expect(removed).toBe(1)

  const indexAfter = await store.getIndex()
  expect(indexAfter.segments.length).toBe(1)

  const remaining = await store.query()
  expect(remaining).toHaveLength(1)
  expect(remaining[0].messageId).toBe('4')
})
