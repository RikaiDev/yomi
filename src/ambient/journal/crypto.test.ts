import { expect, test } from 'bun:test'
import {
  computeEventId,
  decryptPayload,
  deriveJournalKey,
  encryptPayload,
  hashIdentifier,
} from './crypto.js'

test('deriveJournalKey derives stable 32-byte key from context', async () => {
  const key1 = await deriveJournalKey('test-context')
  const key2 = await deriveJournalKey('test-context')
  const key3 = await deriveJournalKey('different-context')

  expect(key1).toHaveLength(32)
  expect(key1.equals(key2)).toBe(true)
  expect(key1.equals(key3)).toBe(false)
})

test('encryptPayload and decryptPayload round-trips UTF-8 plaintext', async () => {
  const key = await deriveJournalKey('test-key')
  const message = 'Hello, LINE Activity Journal! 🚀 這是一條中文測試訊息。'

  const encrypted = encryptPayload(message, key)
  expect(encrypted.length).toBeGreaterThan(message.length)

  const decrypted = decryptPayload(encrypted, key)
  expect(decrypted.toString('utf8')).toBe(message)
})

test('decryptPayload fails on tampered ciphertext or modified tag', async () => {
  const key = await deriveJournalKey('test-key')
  const encrypted = encryptPayload('Confidential Data', key)

  const tampered = Buffer.from(encrypted)
  tampered[tampered.length - 1] ^= 0x01

  expect(() => decryptPayload(tampered, key)).toThrow()
})

test('computeEventId produces deterministic hashes', () => {
  const id1 = computeEventId('u1234', 'msg-001')
  const id2 = computeEventId('u1234', 'msg-001')
  const id3 = computeEventId('u1234', 'msg-002')

  expect(id1).toBe(id2)
  expect(id1).not.toBe(id3)
  expect(id1.length).toBe(24)
})

test('hashIdentifier creates short deterministic hash', () => {
  const h1 = hashIdentifier('chat-123')
  const h2 = hashIdentifier('chat-123')
  expect(h1).toBe(h2)
  expect(h1.length).toBe(16)
})
