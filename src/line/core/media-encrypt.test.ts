import { expect, test } from 'bun:test'
import crypto from 'node:crypto'
import { decryptLineMediaBytes } from './media-decrypt.js'
import {
  buildLineVideoChunkHashes,
  encryptLineMediaBytes,
  encryptLineVideoBytes,
} from './media-encrypt.js'

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

test('encryptLineVideoBytes shares the whole-file CTR ciphertext with encryptLineMediaBytes', async () => {
  // The video ciphertext body (everything before the trailing 32-byte MAC) is
  // byte-for-byte identical to the image/file/audio path — only the MAC differs.
  const keyMaterial = randomKeyMaterial()
  const raw = crypto.randomBytes(300_000) // spans multiple 128 KB chunks
  const media = await encryptLineMediaBytes(raw, keyMaterial)
  const video = await encryptLineVideoBytes(raw, keyMaterial)
  expect(video.length).toBe(raw.length + 32)
  expect(video.subarray(0, raw.length)).toEqual(media.subarray(0, raw.length))
})

test('encryptLineVideoBytes MAC covers the concatenated 128 KB chunk hashes', async () => {
  const keyMaterial = randomKeyMaterial()
  const raw = crypto.randomBytes(300_000)
  const video = await encryptLineVideoBytes(raw, keyMaterial)
  const ciphertext = video.subarray(0, video.length - 32)
  const mac = video.subarray(video.length - 32)

  // Re-derive the MAC key exactly as the encryptor does (HKDF over "FileEncryption").
  const derived = Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(keyMaterial, 'base64'),
      new Uint8Array(0),
      'FileEncryption',
      76,
    ),
  )
  const macKey = derived.subarray(32, 64)
  const hashes = buildLineVideoChunkHashes(ciphertext)
  const expected = crypto.createHmac('sha256', macKey).update(hashes).digest()
  expect(mac).toEqual(expected)
})

test('buildLineVideoChunkHashes emits one 32-byte SHA-256 per 128 KB chunk', () => {
  // 300_000 bytes → chunks of 131072, 131072, 37856 → 3 chunks → 96 bytes.
  const ciphertext = crypto.randomBytes(300_000)
  const hashes = buildLineVideoChunkHashes(ciphertext)
  expect(hashes.length).toBe(3 * 32)
  // The first hash must match SHA-256 of the first 128 KB chunk verbatim.
  const firstChunkHash = crypto
    .createHash('sha256')
    .update(ciphertext.subarray(0, 131072))
    .digest()
  expect(hashes.subarray(0, 32)).toEqual(firstChunkHash)
})
