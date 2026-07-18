/**
 * Crypto Primitives for E2EE
 */

import { Buffer } from 'node:buffer'
import crypto from 'node:crypto'
import { sharedKey as curve25519SharedKey } from 'curve25519-js'

/**
 * Compute SHA-256 hash of input data
 * @param args - Data to hash (strings or Uint8Array)
 * @returns Hash digest as Buffer
 */
function sha256(...args: (string | Uint8Array)[]): Buffer {
  const h = crypto.createHash('sha256')
  for (const a of args) {
    const buf = Buffer.from(a)
    h.update(buf)
  }
  return h.digest()
}

/**
 * XOR the two halves of a buffer together
 * @param buf - Buffer to XOR
 * @returns Resulting buffer with half the length
 */
function xorHalves(buf: Buffer): Buffer {
  const half = Math.floor(buf.length / 2)
  const out = Buffer.alloc(half)
  for (let i = 0; i < half; i++) {
    out[i] = buf[i] ^ buf[half + i]
  }
  return out
}

/**
 * Decrypt data using AES-256-CBC
 * @param data - Encrypted data
 * @param key - Decryption key
 * @param iv - Initialization vector
 * @returns Decrypted data
 */
export function aesDecrypt(data: Buffer, key: Buffer, iv: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/**
 * Compute X25519 shared secret from raw 32-byte keys.
 *
 * @param privateKey - 32-byte private key
 * @param publicKey - 32-byte public key
 * @returns 32-byte shared secret
 */
export function computeSharedSecret(
  privateKey: Buffer | Uint8Array,
  publicKey: Buffer | Uint8Array,
) {
  return Buffer.from(
    curve25519SharedKey(
      Uint8Array.from(privateKey),
      Uint8Array.from(publicKey),
    ),
  )
}

/**
 * Derive AES-256 key and 16-byte IV from shared secret.
 * @param sharedSecret - 32-byte ECDH shared secret
 * @returns Derived key and IV
 */
export function deriveKeyAndIV(sharedSecret: Buffer) {
  return {
    key: sha256(sharedSecret, 'Key'),
    iv: xorHalves(sha256(sharedSecret, 'IV')),
  }
}

/**
 * Derive message-specific key and IV (for V1 messages with salt).
 * @param sharedSecret - 32-byte ECDH shared secret
 * @param salt - Message salt
 * @returns Object containing derived key and IV
 */
export function deriveMessageKeyAndIV(sharedSecret: Buffer, salt: Buffer) {
  return {
    key: sha256(sharedSecret, salt, 'Key'),
    iv: xorHalves(sha256(sharedSecret, salt, 'IV')),
  }
}

/**
 * Derive GCM key for V2 messages.
 * @param sharedSecret - 32-byte ECDH shared secret
 * @param salt - Message salt
 * @returns Derived 32-byte key
 */
export function deriveGCMKey(sharedSecret: Buffer, salt: Buffer) {
  return sha256(sharedSecret, salt, 'Key')
}
