import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { embedMissingBatch } from './collector.js'
import { openDatabase } from './sqlite.js'
import {
  getEmbeddingCount,
  getMaxIndexedMessageTimeByChat,
  getMessagesMissingEmbedding,
  upsertMessages,
} from './store.js'

/**
 * The store keeps one module-level database handle, and bun runs every test
 * file in one process — so a test that reaches for the shared handle writes
 * into the real message index. This file opens its own database and passes
 * the handle in explicitly, the same discipline the persona store test
 * follows.
 */
const dir = mkdtempSync(join(tmpdir(), 'yomi-embed-test-'))
const handle = openDatabase(join(dir, 'index.db'))
handle.exec(`
  CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    messageId TEXT UNIQUE NOT NULL,
    chatId TEXT NOT NULL,
    chatName TEXT,
    fromMid TEXT,
    fromName TEXT,
    text TEXT NOT NULL,
    search_text TEXT NOT NULL,
    createdTime INTEGER,
    contentType INTEGER DEFAULT 0,
    stickerId TEXT,
    stickerPackageId TEXT
  );
`)
handle.exec(`
  CREATE TABLE embeddings (
    messageId TEXT NOT NULL,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vector BLOB NOT NULL,
    PRIMARY KEY (messageId, model)
  );
`)

/** A deterministic stand-in for the local ONNX encoder. */
function fakeEmbedder(label: string) {
  return {
    modelLabel: label,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => [text.length, text.includes('簽到') ? 1 : 0])
    },
    async embedQuery(text: string): Promise<number[]> {
      return [text.length, 0]
    },
  }
}

test('embedMissingBatch embeds only the requested number of rows', async () => {
  const embedder = fakeEmbedder('test-model')
  upsertMessages(
    [
      {
        chatId: 'c1',
        chatName: 'A',
        messageId: 'm1',
        fromMid: 'u1',
        fromName: 'U',
        text: '第一則訊息',
        createdTime: 1000,
      },
      {
        chatId: 'c1',
        chatName: 'A',
        messageId: 'm2',
        fromMid: 'u1',
        fromName: 'U',
        text: '第二則訊息',
        createdTime: 2000,
      },
      {
        chatId: 'c2',
        chatName: 'B',
        messageId: 'm3',
        fromMid: 'u2',
        fromName: 'V',
        text: '第三則訊息',
        createdTime: 3000,
      },
    ],
    handle,
  )

  expect(
    getMessagesMissingEmbedding('test-model', undefined, handle),
  ).toHaveLength(3)

  const embedded = await embedMissingBatch(embedder, 2, handle)
  expect(embedded).toBe(2)
  expect(getEmbeddingCount('test-model', handle)).toBe(2)
  // The third row stays keyword-only until the next batch.
  expect(
    getMessagesMissingEmbedding('test-model', undefined, handle),
  ).toHaveLength(1)
})

test('getMessagesMissingEmbedding honours its limit', () => {
  upsertMessages(
    [
      {
        chatId: 'c3',
        chatName: 'C',
        messageId: 'm10',
        fromMid: 'u1',
        fromName: 'U',
        text: '甲',
        createdTime: 10,
      },
      {
        chatId: 'c3',
        chatName: 'C',
        messageId: 'm11',
        fromMid: 'u1',
        fromName: 'U',
        text: '乙',
        createdTime: 20,
      },
    ],
    handle,
  )
  // Coverage is per model, so this model still sees every unembedded row.
  const all = getMessagesMissingEmbedding('limit-model', undefined, handle)
  expect(all.length).toBeGreaterThanOrEqual(2)
  expect(getMessagesMissingEmbedding('limit-model', 1, handle)).toHaveLength(1)
})

test('getMaxIndexedMessageTimeByChat reports the newest message per chat', () => {
  upsertMessages(
    [
      {
        chatId: 'c4',
        chatName: 'D',
        messageId: 'm20',
        fromMid: 'u1',
        fromName: 'U',
        text: '早',
        createdTime: 111,
      },
      {
        chatId: 'c4',
        chatName: 'D',
        messageId: 'm21',
        fromMid: 'u1',
        fromName: 'U',
        text: '晚',
        createdTime: 999,
      },
      {
        chatId: 'c5',
        chatName: 'E',
        messageId: 'm22',
        fromMid: 'u2',
        fromName: 'V',
        text: '其他',
        createdTime: 500,
      },
    ],
    handle,
  )
  const watermarks = getMaxIndexedMessageTimeByChat(handle)
  expect(watermarks.get('c4')).toBe(999)
  expect(watermarks.get('c5')).toBe(500)
})
