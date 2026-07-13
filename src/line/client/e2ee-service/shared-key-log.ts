import { Buffer } from 'node:buffer'
import {
  extractSharedKeyIdentity,
  readSharedKeyResponseField,
} from './shared-key-payload.js'

/**
 * Build a normalized log payload for group shared-key transport events.
 *
 * @param chatMid - Group or room id.
 * @param shared - Shared-key response payload.
 * @param extra - Additional fields to merge into the payload.
 * @returns Log payload object.
 */
export function buildSharedKeyEventLog(chatMid, shared, extra = {}) {
  const encryptedSharedKey = readSharedKeyResponseField(
    shared,
    'encryptedSharedKey',
    7,
  )
  return {
    chat: chatMid,
    ...extractSharedKeyIdentity(shared),
    encrypted_shared_key_bytes:
      Buffer.isBuffer(encryptedSharedKey) ||
      encryptedSharedKey instanceof Uint8Array
        ? encryptedSharedKey.length
        : typeof encryptedSharedKey === 'string'
          ? encryptedSharedKey.length
          : 0,
    ...extra,
  }
}
