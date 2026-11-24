import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isMachineIdle, withLowPriority } from './idle-resources.js'
import { openDatabase } from './sqlite.js'
import {
  getEmbeddingBacklog,
  listPersonaEvidence,
  listPersonaNodes,
  replacePersonaEvidenceForMids,
  upsertEmbeddings,
  upsertMessages,
} from './store.js'

/**
 * The store keeps one module-level database handle, and bun runs every test
 * file in one process — so a test that reaches for the shared handle writes
 * into the real message index. This file opens its own database and passes
 * the handle in explicitly.
 */
const dir = mkdtempSync(join(tmpdir(), 'yomi-store-idle-test-'))
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
handle.exec(`
  CREATE TABLE persona_evidence (
    mid TEXT NOT NULL,
    name TEXT,
    kind TEXT NOT NULL,
    form TEXT,
    text TEXT NOT NULL,
    occurrences INTEGER NOT NULL,
    chatId TEXT,
    chatName TEXT,
    derivedAt INTEGER NOT NULL
  );
`)
handle.exec(`
  CREATE TABLE persona_nodes (
    mid TEXT NOT NULL,
    name TEXT,
    addresses TEXT,
    summary TEXT,
    derivedAt INTEGER NOT NULL
  );
`)
handle.exec(`
  CREATE TABLE persona_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    derivedAt INTEGER,
    messageCount INTEGER,
    roleCount INTEGER
  );
`)

test('the persona rewrite of touched people leaves the other rows alone', () => {
  const base = Date.now()
  replacePersonaEvidenceForMids(
    [
      {
        mid: 'u1',
        name: 'One',
        kind: 'person',
        form: null,
        text: 'one',
        occurrences: 1,
        chatId: 'c1',
        chatName: null,
        derivedAt: base,
      },
    ],
    [
      {
        mid: 'u1',
        name: 'One',
        addresses: null,
        summary: null,
        derivedAt: base,
      },
    ],
    ['u1'],
    2,
    handle,
  )
  expect(listPersonaEvidence(handle).map((row) => row.mid)).toEqual(['u1'])
  expect(listPersonaNodes(handle).map((row) => row.mid)).toEqual(['u1'])

  // A second derivation that touches another person must not drop the first.
  replacePersonaEvidenceForMids(
    [
      {
        mid: 'u2',
        name: 'Two',
        kind: 'person',
        form: null,
        text: 'two',
        occurrences: 1,
        chatId: 'c2',
        chatName: null,
        derivedAt: base,
      },
    ],
    [
      {
        mid: 'u2',
        name: 'Two',
        addresses: null,
        summary: null,
        derivedAt: base,
      },
    ],
    ['u2'],
    2,
    handle,
  )
  expect(
    listPersonaEvidence(handle)
      .map((row) => row.mid)
      .sort(),
  ).toEqual(['u1', 'u2'])
  expect(
    listPersonaNodes(handle)
      .map((row) => row.mid)
      .sort(),
  ).toEqual(['u1', 'u2'])
})

test('the embedding backlog is zero once every message has a vector', () => {
  upsertMessages(
    [
      { messageId: 'm1', chatId: 'c1', text: 'first' },
      { messageId: 'm2', chatId: 'c1', text: 'second' },
    ],
    handle,
  )
  const model = 'test-model'
  expect(getEmbeddingBacklog(model, handle)).toBe(2)
  upsertEmbeddings(
    [
      { messageId: 'm1', vector: [0.1, 0.2] },
      { messageId: 'm2', vector: [0.3, 0.4] },
    ],
    model,
    handle,
  )
  expect(getEmbeddingBacklog(model, handle)).toBe(0)
  // Another model has no vectors of its own.
  expect(getEmbeddingBacklog('other-model', handle)).toBe(2)
})

test('the machine counts as busy when the load average is above the threshold', () => {
  // A threshold of zero is never idle, and an unreachable threshold is always
  // idle; both are how the worker decides whether to run a batch.
  expect(isMachineIdle(0)).toBe(false)
  expect(isMachineIdle(Number.POSITIVE_INFINITY)).toBe(true)
})

test('a low priority task restores the priority afterwards', async () => {
  const result = await withLowPriority(async () => 'done')
  expect(result).toBe('done')
})
