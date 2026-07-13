import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import {
  aesDecrypt,
  computeSharedSecret,
  deriveGCMKey,
  deriveMessageKeyAndIV,
} from '../crypto/crypto-primitives.js'
import type { PeerPublicKeyCandidate } from './key-types.js'

/**
 * Decrypt a V1 (AES-256-CBC) E2EE payload.
 * @param shared - ECDH shared secret
 * @param salt - Message salt
 * @param ciphertext - Encrypted payload
 * @returns Decrypted UTF-8 string
 */
export function decryptV1(
  shared: Buffer,
  salt: Buffer,
  ciphertext: Buffer,
): string {
  const { key, iv } = deriveMessageKeyAndIV(shared, salt)
  return aesDecrypt(ciphertext, key, iv).toString('utf8')
}

/**
 * Decrypt a V2 (AES-256-GCM) E2EE payload.
 * Auth tag is the last 16 bytes of the ciphertext buffer.
 * @param shared - ECDH shared secret
 * @param salt - Message salt
 * @param ciphertext - Encrypted payload with appended auth tag
 * @param nonce - GCM nonce/sign chunk from the LINE message
 * @param aad - Additional authenticated data derived from message metadata
 * @returns Decrypted UTF-8 string
 */
export function decryptV2(
  shared: Buffer,
  salt: Buffer,
  ciphertext: Buffer,
  nonce: Buffer,
  aad: Buffer,
): string {
  const gcmKey = deriveGCMKey(shared, salt)
  const tagLength = 16
  const encData = ciphertext.subarray(0, ciphertext.length - tagLength)
  const authTag = ciphertext.subarray(ciphertext.length - tagLength)
  const decipher = crypto.createDecipheriv('aes-256-gcm', gcmKey, nonce)
  decipher.setAuthTag(authTag)
  decipher.setAAD(aad)
  return Buffer.concat([decipher.update(encData), decipher.final()]).toString(
    'utf8',
  )
}

/**
 * Try AES-GCM decrypt against multiple sender public keys until one validates.
 *
 * @param privateKey - Group private key
 * @param candidates - Candidate sender public keys
 * @param salt - Message salt
 * @param ciphertext - Ciphertext with auth tag
 * @param nonce - GCM nonce
 * @param buildAAD - Builds candidate-specific additional authenticated data
 * @returns Raw plaintext string
 */
export function decryptV2WithCandidates(
  privateKey: Buffer | Uint8Array,
  candidates: PeerPublicKeyCandidate[],
  salt: Buffer,
  ciphertext: Buffer,
  nonce: Buffer,
  buildAAD: (candidate: PeerPublicKeyCandidate) => Buffer,
): string {
  let lastError: Error | null = null
  for (let index = 0; index < candidates.length; index += 1) {
    try {
      const shared = computeSharedSecret(privateKey, candidates[index].keyData)
      return decryptV2(
        shared,
        salt,
        ciphertext,
        nonce,
        buildAAD(candidates[index]),
      )
    } catch (error) {
      lastError = error as Error
    }
  }
  throw (
    lastError || new Error('No sender key candidate could decrypt the message')
  )
}

/**
 * Extract the user-visible text payload from a decrypted LINE message body.
 *
 * linejs decrypts E2EE text messages into JSON objects such as
 * `{ "text": "hello" }`. Callers expect `tryDecrypt()` to return plain text
 * directly, so this helper unwraps that structure while preserving
 * non-JSON payloads as-is.
 *
 * @param raw - Raw UTF-8 plaintext returned by the crypto layer
 * @returns User-visible text value or the original payload string
 */
export function extractTextPayload(raw: string): string {
  try {
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.text === 'string'
    ) {
      return parsed.text
    }
  } catch {
    // Non-JSON payloads are valid for older/atypical message bodies.
  }
  return raw
}

/**
 * Generate the GCM AAD used by LINE E2EE v2.
 * Matches linejs ordering: to, from, senderKeyId, receiverKeyId, specVersion, contentType.
 *
 * @param to - Message target MID
 * @param from - Message sender MID
 * @param senderKeyId - Sender key ID
 * @param receiverKeyId - Receiver key ID
 * @param specVersion - E2EE version
 * @param contentType - LINE content type
 * @returns Concatenated AAD buffer
 */
export function generateAAD(
  to: string,
  from: string,
  senderKeyId: number,
  receiverKeyId: number,
  specVersion: number,
  contentType: number,
): Buffer {
  return Buffer.concat([
    Buffer.from(to),
    Buffer.from(from),
    getIntBytes(senderKeyId),
    getIntBytes(receiverKeyId),
    getIntBytes(specVersion),
    getIntBytes(contentType),
  ])
}

/**
 * Encode a signed 32-bit integer using the same big-endian byte order as linejs.
 * @param value - Integer value
 * @returns 4-byte buffer
 */
export function getIntBytes(value: number): Buffer {
  const buffer = new ArrayBuffer(4)
  const view = new DataView(buffer)
  view.setInt32(0, value)
  return Buffer.from(new Uint8Array(buffer))
}

/**
 * Convert a raw LINE chunk into a decimal key ID string.
 * @param value - Raw chunk value
 * @returns Parsed key ID string or null when the chunk is not a valid integer
 */
export function toChunkKeyId(value: any): string | null {
  if (value == null) {
    return null
  }
  if (typeof value === 'number') {
    return value > 0 ? String(value) : null
  }
  const buf = Buffer.isBuffer(value)
    ? value
    : value instanceof Uint8Array
      ? Buffer.from(value)
      : Array.isArray(value)
        ? Buffer.from(value)
        : typeof value === 'string'
          ? Buffer.from(value, 'utf8')
          : null

  if (!buf || buf.length === 0 || buf.length > 6) {
    return null
  }

  let parsed = 0
  for (const byte of buf.values()) {
    parsed = (parsed << 8) | byte
  }
  return parsed > 0 ? String(parsed) : null
}
