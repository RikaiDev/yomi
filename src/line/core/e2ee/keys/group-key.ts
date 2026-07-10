import type { GroupKey, KeyManagerContext } from './key-types.js';
import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

import {
  aesDecrypt,
  computeSharedSecret,
  deriveKeyAndIV,
} from '../crypto/crypto-primitives.js';
import { normalizeGroupPublicKeys } from './key-payload.js';
import { getPeerPublicKey } from './peer-key.js';

interface SharedKeyFields {
  creator: string | null;
  creatorKeyId: string;
  sharedReceiverKeyId: string;
  encryptedSharedKey: unknown;
  groupKeyId: string;
}

/**
 * Read one field from a raw shared-key payload using thrift or named access.
 *
 * @param shared - Raw shared-key payload.
 * @param tupleField - Numeric thrift field id.
 * @param namedField - Named object field.
 * @returns Raw field value or null.
 */
function readSharedField(shared: any, tupleField: number, namedField: string): unknown {
  return shared?.[tupleField] ?? shared?.[namedField] ?? null;
}

/**
 * Read one shared-key field and coerce it into a string with fallback support.
 *
 * @param shared - Raw shared-key payload.
 * @param tupleField - Numeric thrift field id.
 * @param namedField - Named object field.
 * @param fallback - Fallback string when the field is absent.
 * @returns String value.
 */
function readSharedString(
  shared: any,
  tupleField: number,
  namedField: string,
  fallback = '',
): string {
  return String(readSharedField(shared, tupleField, namedField) ?? fallback);
}

/**
 * Extract structured fields from a raw LINE group shared key payload.
 * Accepts both thrift tuple and named-property shapes.
 *
 * @param shared - Raw shared key payload
 * @param receiverKeyId - Fallback receiver key ID
 * @param senderMid - Fallback creator MID
 * @param senderKeyId - Fallback creator key ID
 * @returns Normalized fields needed for key derivation
 */
function extractSharedKeyFields(
  shared: any,
  receiverKeyId: string,
  senderMid: string | null,
  senderKeyId: string | null,
): SharedKeyFields {
  const sharedReceiverKeyId = readSharedString(shared, 6, 'receiverKeyId', receiverKeyId);
  const groupKeyId = readSharedString(shared, 2, 'groupKeyId', sharedReceiverKeyId);
  const rawCreator = readSharedField(shared, 3, 'creator');
  const creator = rawCreator == null ? senderMid : String(rawCreator);
  const creatorKeyId = readSharedString(shared, 4, 'creatorKeyId', senderKeyId ?? '');
  const encryptedSharedKey = readSharedField(shared, 7, 'encryptedSharedKey');

  return {
    creator,
    creatorKeyId,
    sharedReceiverKeyId,
    encryptedSharedKey,
    groupKeyId,
  };
}

/**
 * Check memory and persisted store for a cached group key.
 *
 * @param ctx - KeyManager context
 * @param chatMid - Group chat MID
 * @param receiverKeyId - Expected key ID
 * @returns Cached group key or null
 */
async function lookupCachedGroupKey(
  ctx: KeyManagerContext,
  chatMid: string,
  receiverKeyId: string | null,
): Promise<GroupKey | null> {
  const cached = ctx.groupKeys.get(chatMid);
  if (cached && (!receiverKeyId || cached.keyId === receiverKeyId)) {
    ctx.logGroupKeyEvent('e2ee.group_key.cache_hit', {
      chat: chatMid,
      source: 'memory',
      receiver_key_id: receiverKeyId,
      group_key_id: cached.keyId,
    });
    return cached;
  }

  const store = ctx.getStore();
  const persisted = await store?.get?.(`line_e2ee_group_by_mid:${chatMid}`);
  if (!persisted) {
    return null;
  }
  const parsed = JSON.parse(persisted);
  if (receiverKeyId && String(parsed.keyId) !== String(receiverKeyId)) {
    return null;
  }
  const groupKey = { keyId: String(parsed.keyId), privateKey: Buffer.from(parsed.privateKey, 'base64') };
  ctx.groupKeys.set(chatMid, groupKey);
  ctx.logGroupKeyEvent('e2ee.group_key.cache_hit', {
    chat: chatMid,
    source: 'persisted',
    receiver_key_id: receiverKeyId,
    group_key_id: groupKey.keyId,
  });
  return groupKey;
}

/**
 * Return a stable fetch key for one group-key resolution request.
 *
 * @param chatMid - Group chat MID
 * @param receiverKeyId - Expected receiver key id
 * @returns Stable in-flight fetch key
 */
function getGroupKeyFetchKey(chatMid: string, receiverKeyId: string): string {
  return `${chatMid}:${receiverKeyId}`;
}

/**
 * Derive and cache a group key from the shared key payload.
 *
 * @param ctx - KeyManager context
 * @param chatMid - Group chat MID
 * @param shared - Raw shared key payload from LINE
 * @param receiverKeyId - Receiver key ID fallback
 * @param senderMid - Sender MID fallback
 * @param senderKeyId - Sender key ID fallback
 * @param resolutionSource - Label used in diagnostic logs
 * @returns Derived group key
 */
async function deriveAndCacheGroupKey(
  ctx: KeyManagerContext,
  chatMid: string,
  shared: any,
  receiverKeyId: string,
  senderMid: string | null,
  senderKeyId: string | null,
  resolutionSource: string,
): Promise<GroupKey> {
  const { creator, creatorKeyId, sharedReceiverKeyId, encryptedSharedKey, groupKeyId }
    = extractSharedKeyFields(shared, receiverKeyId, senderMid, senderKeyId);

  const selfKey = ctx.getSelfKeyById(sharedReceiverKeyId);
  if (!selfKey) {
    ctx.raiseWarning('missing_self_key', { receiverKeyId: sharedReceiverKeyId, chatMid });
    throw new Error(`Missing self E2EE key for receiverKeyId=${sharedReceiverKeyId}`);
  }
  if (!creator || !creatorKeyId || !encryptedSharedKey) {
    throw new Error('Incomplete group shared key payload');
  }

  const selfMid = ctx.getProfileMid();
  const creatorPublicKey = creator === selfMid
    ? selfKey.publicKey
    : await getPeerPublicKey(ctx, creator, creatorKeyId);
  const aesSecret = computeSharedSecret(selfKey.privateKey, creatorPublicKey);
  const { key, iv } = deriveKeyAndIV(aesSecret);
  const raw = encryptedSharedKey as any;
  const encrypted = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, typeof raw === 'string' ? 'base64' : undefined);
  const plainText = aesDecrypt(encrypted, key, iv);
  const groupKey: GroupKey = { keyId: groupKeyId, privateKey: plainText };

  ctx.groupKeys.set(chatMid, groupKey);
  const store = ctx.getStore();
  await store?.set?.(`line_e2ee_group_by_mid:${chatMid}`, JSON.stringify({
    keyId: groupKey.keyId,
    privateKey: groupKey.privateKey.toString('base64'),
  }));
  ctx.logGroupKeyEvent('e2ee.group_key.resolved', {
    chat: chatMid,
    source: resolutionSource,
    receiver_key_id: sharedReceiverKeyId,
    creator,
    creator_key_id: creatorKeyId,
    group_key_id: groupKeyId,
    encrypted_shared_key_bytes: encrypted.length,
  });
  return groupKey;
}

/**
 * Resolve and cache the group shared key for a chat.
 *
 * @param ctx - KeyManager context
 * @param chatMid - Group chat MID
 * @param receiverKeyId - Local receiver key ID
 * @param senderMid - Sender MID
 * @param senderKeyId - Sender key ID
 * @returns Group key or undefined when unavailable
 */
export async function getGroupKey(
  ctx: KeyManagerContext,
  chatMid: string,
  receiverKeyId: string | null,
  senderMid: string | null,
  senderKeyId: string | null,
): Promise<GroupKey | undefined> {
  if (!receiverKeyId) {
    const cachedLatest = await lookupCachedGroupKey(ctx, chatMid, null);
    if (cachedLatest) {
      return cachedLatest;
    }
  }

  const cached = await lookupCachedGroupKey(ctx, chatMid, receiverKeyId);
  if (cached) {
    return cached;
  }

  const resolvedReceiverKeyId = receiverKeyId || 'latest';
  const fetchKey = getGroupKeyFetchKey(chatMid, resolvedReceiverKeyId);
  const inflight = ctx.groupKeyFetches.get(fetchKey);
  if (inflight) {
    ctx.logGroupKeyEvent('e2ee.group_key.fetch_join', {
      chat: chatMid,
      receiver_key_id: receiverKeyId,
      inflight_receiver_key_id: inflight.receiverKeyId,
    });
    return inflight.promise;
  }

  const fetchPromise = (async () => {
    const client = ctx.getClient();
    let shared;
    let resolutionSource = 'server_fetch';
    try {
      shared = await client?.getLastE2EEGroupSharedKey?.(2, chatMid);
    }
    catch (error: any) {
      const code = typeof error?.data?.code === 'string' ? error.data.code : null;
      const message: string = error?.message || String(error);
      const shouldFallback = code === 'NOT_FOUND' || message.toLowerCase().includes('no valid group key');
      if (!shouldFallback) {
        ctx.logGroupKeyEvent('e2ee.group_key.fetch_failed', { chat: chatMid, receiver_key_id: receiverKeyId, code, error: message });
        throw error;
      }
      resolutionSource = 'register_fallback';
    }
    if (!shared) {
      shared = await tryRegisterE2EEGroupKey(ctx, chatMid);
    }
    if (!shared) {
      ctx.logGroupKeyEvent('e2ee.group_key.unavailable', { chat: chatMid, receiver_key_id: receiverKeyId, source: resolutionSource });
      return undefined;
    }

    return deriveAndCacheGroupKey(ctx, chatMid, shared, resolvedReceiverKeyId, senderMid, senderKeyId, resolutionSource);
  })();

  ctx.groupKeyFetches.set(fetchKey, {
    receiverKeyId: resolvedReceiverKeyId,
    promise: fetchPromise,
  });
  try {
    return await fetchPromise;
  }
  finally {
    ctx.groupKeyFetches.delete(fetchKey);
  }
}

/**
 * Try to create and register a group shared key when LINE has not created one
 * yet for the current chat. This mirrors linejs tryRegisterE2EEGroupKey():
 * fetch the latest member public keys, generate one random 32-byte group key,
 * encrypt it for each member using our current self key, then register the
 * resulting bundle back to LINE.
 *
 * @param ctx - KeyManager context
 * @param chatMid - Group chat MID
 * @returns Newly registered group-shared-key payload or undefined
 */
export async function tryRegisterE2EEGroupKey(ctx: KeyManagerContext, chatMid: string): Promise<any> {
  const client = ctx.getClient();
  const selfMid = ctx.getProfileMid();
  if (!client || !selfMid) {
    return undefined;
  }

  const keyMap = normalizeGroupPublicKeys(await client.getLastE2EEPublicKeys?.(chatMid));
  const selfPublicKey = keyMap.get(selfMid);
  if (!selfPublicKey) {
    ctx.raiseWarning('missing_self_key', { profileMid: selfMid, chatMid });
    return undefined;
  }
  const selfKey = ctx.getSelfKeyById(selfPublicKey.keyId) || ctx.getSelfKeyByMid(selfMid);
  if (!selfKey) {
    ctx.raiseWarning('missing_self_key', { receiverKeyId: selfPublicKey.keyId, chatMid });
    return undefined;
  }

  const groupPrivateKey = crypto.randomBytes(32);
  const members: string[] = [];
  const keyIds: number[] = [];
  const encryptedSharedKeys: Buffer[] = [];

  for (const [memberMid, memberKey] of keyMap.entries()) {
    const aesSecret = computeSharedSecret(selfKey.privateKey, memberKey.keyData);
    const { key, iv } = deriveKeyAndIV(aesSecret);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encryptedSharedKey = Buffer.concat([cipher.update(groupPrivateKey), cipher.final()]);
    members.push(memberMid);
    keyIds.push(Number(memberKey.keyId));
    encryptedSharedKeys.push(encryptedSharedKey);
  }

  return client.registerE2EEGroupKey?.(1, chatMid, members, keyIds, encryptedSharedKeys);
}

/**
 * Drop one cached/persisted group key so the next decrypt attempt refetches it
 * from LINE instead of trusting a stale local copy with the same key id.
 *
 * @param ctx - KeyManager context
 * @param chatMid - Group or room MID
 */
export async function invalidateGroupKey(ctx: KeyManagerContext, chatMid: string): Promise<void> {
  ctx.groupKeys.delete(chatMid);
  for (const key of Array.from(ctx.groupKeyFetches.keys())) {
    if (key.startsWith(`${chatMid}:`)) {
      ctx.groupKeyFetches.delete(key);
    }
  }
  const store = ctx.getStore();
  await store?.delete?.(`line_e2ee_group_by_mid:${chatMid}`);
  ctx.logGroupKeyEvent('e2ee.group_key.invalidated', { chat: chatMid });
}

export { normalizeGroupPublicKeys } from './key-payload.js';
