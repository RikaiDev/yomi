import crypto from 'node:crypto';

/**
 * Derive LINE E2EE media keys from decrypted key material.
 *
 * @param keyMaterial - Base64 LINE media key material.
 * @returns Encryption key and nonce.
 */
async function deriveLineMediaKeyMaterial(keyMaterial: string): Promise<{ encKey: Buffer; nonce: Buffer }> {
  const material = Buffer.from(keyMaterial, 'base64');
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.hkdf('sha256', material, new Uint8Array(0), 'FileEncryption', 76, (error, key) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(Buffer.from(key));
    });
  });
  return {
    encKey: derived.subarray(0, 32),
    nonce: Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4)]),
  };
}

/**
 * Decrypt LINE E2EE media bytes.
 *
 * LINE appends a 32-byte MAC to the encrypted media payload. The existing
 * LINE client implementations decrypt AES-CTR then strip that MAC suffix.
 *
 * @param encryptedBytes - Downloaded encrypted media bytes.
 * @param keyMaterial - Base64 key material from the E2EE data message.
 * @returns Decrypted media bytes.
 */
export async function decryptLineMediaBytes(encryptedBytes: Buffer, keyMaterial: string): Promise<Buffer> {
  const keys = await deriveLineMediaKeyMaterial(keyMaterial);
  const decipher = crypto.createDecipheriv('aes-256-ctr', keys.encKey, keys.nonce);
  const decrypted = Buffer.concat([decipher.update(encryptedBytes), decipher.final()]);
  return decrypted.subarray(0, Math.max(0, decrypted.length - 32));
}
