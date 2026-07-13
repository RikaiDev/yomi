import { expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { decryptLineMediaBytes } from './media-decrypt.js'
import { encryptLineMediaBytes } from './media-encrypt.js'

/**
 * Generate a random base64 key material the same shape LINE issues
 * (32 random bytes, base64-encoded).
 */
function randomKeyMaterial(): string {
  return crypto.randomBytes(32).toString('base64')
}

test('encryptLineMediaBytes round-trips through decryptLineMediaBytes (small payload)', async () => {
  const keyMaterial = randomKeyMaterial()
  const raw = crypto.randomBytes(16)
  const encrypted = await encryptLineMediaBytes(raw, keyMaterial)
  const decrypted = await decryptLineMediaBytes(encrypted, keyMaterial)
  expect(decrypted).toEqual(raw)
})

test('encryptLineMediaBytes round-trips through decryptLineMediaBytes (few-KB payload)', async () => {
  const keyMaterial = randomKeyMaterial()
  const raw = crypto.randomBytes(8192)
  const encrypted = await encryptLineMediaBytes(raw, keyMaterial)
  const decrypted = await decryptLineMediaBytes(encrypted, keyMaterial)
  expect(decrypted).toEqual(raw)
})

test('encryptLineMediaBytes appends a distinct 32-byte MAC suffix', async () => {
  const keyMaterial = randomKeyMaterial()
  const raw = crypto.randomBytes(1024)
  const encrypted = await encryptLineMediaBytes(raw, keyMaterial)
  expect(encrypted.length).toBe(raw.length + 32)
})

test('encryptLineMediaBytes round-trips an empty payload', async () => {
  const keyMaterial = randomKeyMaterial()
  const raw = Buffer.alloc(0)
  const encrypted = await encryptLineMediaBytes(raw, keyMaterial)
  const decrypted = await decryptLineMediaBytes(encrypted, keyMaterial)
  expect(decrypted).toEqual(raw)
})
