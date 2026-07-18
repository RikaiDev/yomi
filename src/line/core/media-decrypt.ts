import crypto from 'node:crypto'
import { buildLineVideoChunkHashes } from './media-encrypt.js'

/**
 * Derive LINE E2EE media keys from decrypted key material.
 *
 * @param keyMaterial - Base64 LINE media key material.
 * @returns Encryption key, MAC key, and CTR nonce.
 */
async function deriveLineMediaKeyMaterial(
  keyMaterial: string,
): Promise<{ encKey: Buffer; macKey: Buffer; nonce: Buffer }> {
  const material = Buffer.from(keyMaterial, 'base64')
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.hkdf(
      'sha256',
      material,
      new Uint8Array(0),
      'FileEncryption',
      76,
      (error, key) => {
        if (error) {
          reject(error)
          return
        }
        resolve(Buffer.from(key))
      },
    )
  })
  return {
    encKey: derived.subarray(0, 32),
    macKey: derived.subarray(32, 64),
    nonce: Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4)]),
  }
}

/** Thrown when a media object's MAC does not match its ciphertext. */
class MediaMacVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MediaMacVerificationError'
  }
}

/**
 * Decrypt LINE E2EE media bytes, verifying the trailing MAC first.
 *
 * LINE appends a 32-byte MAC, in the clear, after the AES-256-CTR ciphertext.
 * It is keyed with the HKDF's macKey and comes in two constructions, selected
 * by which OBS object is being read — NOT by contentType alone:
 *
 *   - whole-file  : HMAC-SHA256(macKey, ciphertext)
 *                   images, audio, files, AND a video's `__ud-preview` poster
 *   - chunked     : HMAC-SHA256(macKey, ‖ SHA-256(128 KB chunk of ciphertext))
 *                   a video's main body only
 *
 * Both constructions were confirmed against real received media (image, audio,
 * video body, and that same video's preview) rather than inferred from the send
 * path — the send path could not settle it, because nothing verified these MACs
 * in either direction, so a wrong construction would have gone unnoticed.
 *
 * Verification is not optional hardening. AES-CTR is malleable: without it, any
 * party able to alter the downloaded bytes — starting with LINE's own OBS
 * servers, which is precisely who E2EE exists to defend against — can flip
 * chosen bits of the decrypted plaintext undetected.
 *
 * @param encryptedBytes - Downloaded encrypted media bytes (ciphertext ‖ MAC).
 * @param keyMaterial - Base64 key material from the E2EE data message.
 * @param options - Which MAC construction applies.
 * @param options.chunkHashMac - True only for a video's main body.
 * @returns Decrypted media bytes.
 * @throws MediaMacVerificationError when the MAC does not match.
 */
export async function decryptLineMediaBytes(
  encryptedBytes: Buffer,
  keyMaterial: string,
  options: { chunkHashMac?: boolean } = {},
): Promise<Buffer> {
  const keys = await deriveLineMediaKeyMaterial(keyMaterial)

  if (encryptedBytes.length < 32) {
    throw new MediaMacVerificationError(
      `media object is ${encryptedBytes.length} bytes — too short to carry a 32-byte MAC`,
    )
  }
  const ciphertext = encryptedBytes.subarray(0, encryptedBytes.length - 32)
  const mac = encryptedBytes.subarray(encryptedBytes.length - 32)

  const expected = crypto
    .createHmac('sha256', keys.macKey)
    .update(
      options.chunkHashMac ? buildLineVideoChunkHashes(ciphertext) : ciphertext,
    )
    .digest()
  if (!crypto.timingSafeEqual(expected, mac)) {
    throw new MediaMacVerificationError(
      `media MAC mismatch (${options.chunkHashMac ? 'chunked' : 'whole-file'} construction, ${ciphertext.length}B ciphertext) — the object was altered in transit or is not the object this key belongs to`,
    )
  }

  const decipher = crypto.createDecipheriv(
    'aes-256-ctr',
    keys.encKey,
    keys.nonce,
  )
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
