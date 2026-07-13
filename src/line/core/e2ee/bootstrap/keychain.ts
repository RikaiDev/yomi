/**
 * LINE E2EE login bootstrap keychain decryption.
 */

import { Buffer } from 'node:buffer'
import * as crypto from 'node:crypto'
import { readStructFields } from '../../thrift/index.js'
import {
  computeSharedSecret,
  deriveKeyAndIV,
} from '../crypto/crypto-primitives.js'

/**
 * Decrypt the E2EE key chain from login response.
 *
 * @param encryptedKeyChain - From login metaData.encryptedKeyChain (base64 decoded)
 * @param serverPublicKey - From login metaData.publicKey (base64 decoded, 32 bytes)
 * @param ourPrivateKey - Our NaCl 32-byte private key (secretKey from login)
 * @returns Parsed E2EE keys
 */
export function decryptKeyChain(
  encryptedKeyChain: Buffer,
  serverPublicKey: Buffer,
  ourPrivateKey: Buffer,
) {
  const shared = computeSharedSecret(ourPrivateKey, serverPublicKey)
  const { key, iv } = deriveKeyAndIV(shared)

  const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv)
  decipher.setAutoPadding(false)
  const decrypted = Buffer.concat([
    decipher.update(encryptedKeyChain),
    decipher.final(),
  ])
  const parsed = readStructFields(decrypted)
  const keyList = (parsed as any)[1]
  if (!Array.isArray(keyList)) {
    return []
  }

  return keyList.map((keyStruct) => ({
    version: keyStruct[1],
    keyId: keyStruct[2],
    publicKey: Buffer.isBuffer(keyStruct[4])
      ? keyStruct[4]
      : Buffer.from(keyStruct[4]),
    privateKey: Buffer.isBuffer(keyStruct[5])
      ? keyStruct[5]
      : Buffer.from(keyStruct[5]),
    createdTime: keyStruct[6] ? Number(keyStruct[6]) : null,
  }))
}
