import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deriveJournalKey } from '../journal/crypto.js'
import { LineActivityJournalStore } from '../journal/journal-store.js'
import type { LineActivityEvent } from '../journal/types.js'
import { CoarseToFineRetriever } from './retriever.js'

let tempDir: string
let store: LineActivityJournalStore
let retriever: CoarseToFineRetriever

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'yomi-retriever-test-'))
  const key = await deriveJournalKey('retriever-test')
  store = new LineActivityJournalStore({
    baseDir: tempDir,
    encryptionKey: key,
  })
  retriever = new CoarseToFineRetriever(store)
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

test('coarse-to-fine retriever drills down from rollups to episodes to raw events', async () => {
  const base = 1_000_000
  const e1 = makeEvent('1', 'chat-1', base, 'Can you send the invoice?', {
    isSelf: true,
  })
  const e2 = makeEvent('2', 'chat-1', base + 10_000, 'Sure, attached.', {
    contentType: 'file',
    isSelf: false,
    senderName: 'Bob',
  })
  const e3 = makeEvent('3', 'chat-2', base + 20_000, 'Just chilling')

  await store.append([e1, e2, e3])

  // Step 1: Coarse Rollup
  const rollups = await retriever.retrieveRollups(
    base - 1000,
    base + 24 * 3600 * 1000,
  )
  expect(rollups.length).toBeGreaterThan(0)
  expect(rollups[0].totalEvents).toBe(3)

  // Step 2: Medium Episode Retrieval
  const episodes = await retriever.retrieveEpisodes({
    chatId: 'chat-1',
    onlyActionable: true,
  })
  expect(episodes).toHaveLength(1)
  expect(episodes[0].messageIds).toEqual(['1', '2'])
  expect(episodes[0].responseState).toBe('received')

  // Step 3: Fine Connected Evidence
  const candidate = await retriever.retrieveConnectedEvidence(episodes[0])
  expect(candidate.events).toHaveLength(2)
  expect(candidate.events[0].text).toBe('Can you send the invoice?')
  expect(candidate.events[1].contentType).toBe('file')
})
