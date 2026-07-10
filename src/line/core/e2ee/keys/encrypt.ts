import type { EncryptedMessagePayload, KeyManagerContext } from './key-types.js';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

import { computeSharedSecret, deriveGCMKey } from '../crypto/crypto-primitives.js';
import { getGroupKey } from './group-key.js';
import { normalizeNegotiatedPublicKey } from './key-payload.js';
import { generateAAD, getIntBytes } from './message-crypto.js';

/**
 * Infer the LINE MID type from its leading prefix.
 * `u` = user, `c` = group, `r` = room.
 *
 * @param mid - LINE MID
 * @returns Numeric MID type compatible with Talk/E2EE logic
 */
function getMidType(mid: string): number {
  if (typeof mid !== 'string' || mid.length === 0) {
    return -1;
  }
  if (mid.startsWith('u')) {
    return 0;
  }
  if (mid.startsWith('c')) {
    return 1;
  }
  if (mid.startsWith('r')) {
    return 2;
  }
  return -1;
}

/**
 * Encrypt an outbound LINE E2EE v2 payload and append the GCM auth tag.
 *
 * @param data - Serialized message payload
 * @param gcmKey - Derived AES-GCM key
 * @param nonce - Random 12-byte GCM nonce
 * @param aad - Additional authenticated data
 * @returns Ciphertext buffer with trailing auth tag
 */
function encryptE2EEMessageV2(data: Buffer, gcmKey: Buffer, nonce: Buffer, aad: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-256-gcm', gcmKey, nonce);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([encrypted, cipher.getAuthTag()]);
}

/**
 * Prepare an outbound LINE E2EE payload using the same chunk layout as linejs.
 *
 * The returned structure is transport-ready for TalkService sendMessage:
 * `chunks` contains `[salt, ciphertext+tag, nonce, senderKeyIdBytes, receiverKeyIdBytes]`
 * and `contentMetadata` includes the E2EE markers LINE expects for version 2.
 *
 * @param ctx - KeyManager context
 * @param to - Target LINE MID
 * @param data - Text or structured payload to encrypt
 * @param contentType - LINE content type of the payload
 * @returns Message chunks plus metadata required by LINE
 */
export async function encryptE2EEMessage(
  ctx: KeyManagerContext,
  to: string,
  data: string | Record<string, any>,
  contentType = 0,
): Promise<EncryptedMessagePayload> {
  const selfMid = ctx.getProfileMid();
  if (!selfMid) {
    throw new Error('Cannot encrypt E2EE message without an authenticated LINE profile');
  }

  const selfKey = ctx.getSelfKeyByMid(selfMid);
  if (!selfKey) {
    throw new Error(`Missing self E2EE key for mid=${selfMid}`);
  }

  const toType = getMidType(to);
  if (![0, 1, 2].includes(toType)) {
    throw new Error(`Invalid LINE target MID for E2EE: ${to}`);
  }

  const senderKeyId = Number(selfKey.keyId);
  let receiverKeyId: number;
  let sharedSecret: Buffer;

  if (toType === 0) {
    const publicKey = normalizeNegotiatedPublicKey(await ctx.getClient()?.negotiateE2EEPublicKey?.(to));
    if (!publicKey) {
      throw new Error(`Failed to negotiate peer E2EE public key for ${to}`);
    }
    receiverKeyId = Number(publicKey.keyId);
    sharedSecret = computeSharedSecret(selfKey.privateKey, publicKey.keyData);
  }
  else {
    const groupKey = await getGroupKey(ctx, to, null, selfMid, selfKey.keyId);
    if (!groupKey) {
      throw new Error(`Failed to resolve LINE group E2EE key for ${to}`);
    }
    receiverKeyId = Number(groupKey.keyId);
    sharedSecret = computeSharedSecret(groupKey.privateKey, selfKey.publicKey);
  }

  const specVersion = 2;
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const gcmKey = deriveGCMKey(sharedSecret, salt);
  const aad = generateAAD(to, selfMid, senderKeyId, receiverKeyId, specVersion, contentType);
  const serialized = typeof data === 'string'
    ? Buffer.from(JSON.stringify({ text: data }))
    : Buffer.from(JSON.stringify(contentType === 15 ? { location: data } : data));
  const ciphertext = encryptE2EEMessageV2(serialized, gcmKey, nonce, aad);

  return {
    chunks: [salt, ciphertext, nonce, getIntBytes(senderKeyId), getIntBytes(receiverKeyId)],
    contentType,
    contentMetadata: { e2eeVersion: '2', contentType: String(contentType), e2eeMark: '2' },
  };
}
