import crypto from 'node:crypto';

/**
 * Derive LINE E2EE media keys from key material, mirroring the derivation
 * in media-decrypt.ts exactly (same HKDF params, same key/nonce layout) so
 * ciphertext produced here is decryptable by decryptLineMediaBytes.
 *
 * @param keyMaterial - Base64 LINE media key material.
 * @returns Encryption key, MAC key, and CTR nonce.
 */
async function deriveLineMediaKeyMaterial(keyMaterial: string): Promise<{ encKey: Buffer; macKey: Buffer; nonce: Buffer }> {
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
    macKey: derived.subarray(32, 64),
    nonce: Buffer.concat([derived.subarray(64, 76), Buffer.alloc(4)]),
  };
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
export async function encryptLineMediaBytes(raw: Buffer, keyMaterial: string): Promise<Buffer> {
  const keys = await deriveLineMediaKeyMaterial(keyMaterial);
  const cipher = crypto.createCipheriv('aes-256-ctr', keys.encKey, keys.nonce);
  const ciphertext = Buffer.concat([cipher.update(raw), cipher.final()]);
  const mac = crypto.createHmac('sha256', keys.macKey).update(ciphertext).digest();
  return Buffer.concat([ciphertext, mac]);
}
