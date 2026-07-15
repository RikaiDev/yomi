import crypto from 'node:crypto'

/**
 * Derive LINE E2EE media keys from key material, mirroring the derivation
 * in media-decrypt.ts exactly (same HKDF params, same key/nonce layout) so
 * ciphertext produced here is decryptable by decryptLineMediaBytes.
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

/**
 * Encrypt LINE E2EE media bytes for outbound upload.
 *
 * Mirrors decryptLineMediaBytes in reverse: AES-256-CTR encrypt with the
 * derived key/nonce, then append an HMAC-SHA256 MAC (computed over the
 * ciphertext only) as the trailing 32 bytes — the exact layout
 * decryptLineMediaBytes expects to strip.
 *
 * @param raw - Plaintext media bytes to encrypt.
 * @param keyMaterial - Base64 key material (caller-generated, 32 random bytes).
 * @returns Ciphertext with the trailing 32-byte MAC appended.
 */
export async function encryptLineMediaBytes(
  raw: Buffer,
  keyMaterial: string,
): Promise<Buffer> {
  const keys = await deriveLineMediaKeyMaterial(keyMaterial)
  const cipher = crypto.createCipheriv('aes-256-ctr', keys.encKey, keys.nonce)
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()])
  const mac = crypto
    .createHmac('sha256', keys.macKey)
    .update(ciphertext)
    .digest()
  return Buffer.concat([ciphertext, mac])
}

/** LINE video E2EE chunk size — the ciphertext is hashed in 128 KB pieces. */
const LINE_VIDEO_CHUNK_SIZE = 131072

/**
 * Concatenate the SHA-256 hash of each 128 KB chunk of a video ciphertext.
 *
 * Video E2EE lets the receiver verify integrity while streaming, so instead of
 * one MAC over the whole ciphertext (image/audio/file), the ciphertext is split
 * into 128 KB chunks, each hashed with SHA-256, and those hashes are what the
 * MAC covers. Pass the ciphertext WITHOUT any trailing MAC — the hashes must
 * match the bytes a receiver actually downloads and re-hashes per chunk.
 *
 * @param ciphertext - AES-256-CTR video ciphertext (no trailing MAC).
 * @returns The N chunk hashes concatenated (N × 32 bytes).
 */
export function buildLineVideoChunkHashes(ciphertext: Buffer): Buffer {
  const hashes: Buffer[] = []
  for (
    let offset = 0;
    offset < ciphertext.length;
    offset += LINE_VIDEO_CHUNK_SIZE
  ) {
    hashes.push(
      crypto
        .createHash('sha256')
        .update(ciphertext.subarray(offset, offset + LINE_VIDEO_CHUNK_SIZE))
        .digest(),
    )
  }
  return Buffer.concat(hashes)
}

/**
 * Encrypt LINE E2EE video bytes for outbound upload.
 *
 * The ciphertext is byte-for-byte identical to {@link encryptLineMediaBytes}
 * (same whole-file AES-256-CTR stream — the whitepaper's per-chunk decryption
 * IV `IV‖(i*8192)` is exactly the same CTR state continued at each 128 KB
 * boundary). Only the MAC differs: it is computed over the concatenation of the
 * per-chunk SHA-256 hashes rather than over the raw ciphertext, then appended
 * as the trailing 32 bytes. The separate chunk-hash manifest object the
 * receiver needs is produced by {@link buildLineVideoChunkHashes}.
 *
 * @param raw - Plaintext video bytes to encrypt.
 * @param keyMaterial - Base64 key material (caller-generated, 32 random bytes).
 * @returns Ciphertext with the trailing 32-byte chunk-hash MAC appended.
 */
export async function encryptLineVideoBytes(
  raw: Buffer,
  keyMaterial: string,
): Promise<Buffer> {
  const keys = await deriveLineMediaKeyMaterial(keyMaterial)
  const cipher = crypto.createCipheriv('aes-256-ctr', keys.encKey, keys.nonce)
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()])
  const mac = crypto
    .createHmac('sha256', keys.macKey)
    .update(buildLineVideoChunkHashes(ciphertext))
    .digest()
  return Buffer.concat([ciphertext, mac])
}
