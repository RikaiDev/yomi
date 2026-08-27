import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdf,
  randomBytes,
} from 'node:crypto'

const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32

/**
 * Derive an encryption key from a seed or context string using HKDF-SHA256.
 */
export async function deriveJournalKey(secretContext: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    hkdf(
      'sha256',
      Buffer.from(secretContext, 'utf8'),
      Buffer.from('YomiJournalSalt', 'utf8'),
      'LineActivityEventJournalKey',
      KEY_LENGTH,
      (err, key) => {
        if (err) reject(err)
        else resolve(Buffer.from(key))
      },
    )
  })
}

/**
 * Encrypt a plaintext buffer with AES-256-GCM authenticated encryption.
 * Output format: [12-byte IV][16-byte Auth Tag][Ciphertext]
 */
export function encryptPayload(
  plaintext: Buffer | string,
  key: Buffer,
): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `Invalid journal encryption key length: expected ${KEY_LENGTH} bytes, got ${key.length}`,
    )
  }
  const input =
    typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(input), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

/**
 * Decrypt an AES-256-GCM envelope produced by encryptPayload.
 */
export function decryptPayload(envelope: Buffer, key: Buffer): Buffer {
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `Invalid journal encryption key length: expected ${KEY_LENGTH} bytes, got ${key.length}`,
    )
  }
  if (envelope.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted envelope is truncated')
  }
  const iv = envelope.subarray(0, IV_LENGTH)
  const tag = envelope.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = envelope.subarray(IV_LENGTH + TAG_LENGTH)

  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}

export function hashIdentifier(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16)
}

export function computeEventId(chatId: string, messageId: string): string {
  return createHash('sha256')
    .update(`${chatId}\0${messageId}`)
    .digest('hex')
    .slice(0, 24)
}
