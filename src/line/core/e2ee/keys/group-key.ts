import { Buffer } from 'node:buffer'
import {
  aesDecrypt,
  computeSharedSecret,
  deriveKeyAndIV,
} from '../crypto/crypto-primitives.js'
import type { GroupKey, KeyManagerContext } from './key-types.js'
import { getPeerPublicKey } from './peer-key.js'

interface SharedKeyFields {
  creator: string | null
  creatorKeyId: string
  sharedReceiverKeyId: string
  encryptedSharedKey: unknown
  groupKeyId: string
}

/**
 * Read one field from a raw shared-key payload using thrift or named access.
 *
 * @param shared - Raw shared-key payload.
 * @param tupleField - Numeric thrift field id.
 * @param namedField - Named object field.
 * @returns Raw field value or null.
 */
function readSharedField(
  shared: any,
  tupleField: number,
  namedField: string,
): unknown {
  return shared?.[tupleField] ?? shared?.[namedField] ?? null
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
  return String(readSharedField(shared, tupleField, namedField) ?? fallback)
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
  const sharedReceiverKeyId = readSharedString(
    shared,
    6,
    'receiverKeyId',
    receiverKeyId,
  )
  const groupKeyId = readSharedString(
    shared,
    2,
    'groupKeyId',
    sharedReceiverKeyId,
  )
  const rawCreator = readSharedField(shared, 3, 'creator')
  const creator = rawCreator == null ? senderMid : String(rawCreator)
  const creatorKeyId = readSharedString(
    shared,
    4,
    'creatorKeyId',
    senderKeyId ?? '',
  )
  const encryptedSharedKey = readSharedField(shared, 7, 'encryptedSharedKey')

  return {
    creator,
    creatorKeyId,
    sharedReceiverKeyId,
    encryptedSharedKey,
    groupKeyId,
  }
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
  // Epoch-aware cache: keys are stored per (chat, groupKeyId) and never
  // overwritten, so once this device has seen a group-key epoch it keeps
  // decrypting that epoch's messages even after the group rekeys. Without a
  // specific epoch (the send path asks for "latest"), skip the cache and let
  // the caller fetch the current key from LINE.
  if (!receiverKeyId) {
    return null
  }
  const cacheKey = `${chatMid}:${receiverKeyId}`
  const cached = ctx.groupKeys.get(cacheKey)
  if (cached) {
    ctx.logGroupKeyEvent('e2ee.group_key.cache_hit', {
      chat: chatMid,
      source: 'memory',
      receiver_key_id: receiverKeyId,
      group_key_id: cached.keyId,
    })
    return cached
  }

  const store = ctx.getStore()
  const persisted = await store?.get?.(`line_e2ee_group_by_mid:${cacheKey}`)
  if (!persisted) {
    return null
  }
  const parsed = JSON.parse(persisted)
  const groupKey = {
    keyId: String(parsed.keyId),
    privateKey: Buffer.from(parsed.privateKey, 'base64'),
  }
  ctx.groupKeys.set(cacheKey, groupKey)
  ctx.logGroupKeyEvent('e2ee.group_key.cache_hit', {
    chat: chatMid,
    source: 'persisted',
    receiver_key_id: receiverKeyId,
    group_key_id: groupKey.keyId,
  })
  return groupKey
}

/**
 * Return a stable fetch key for one group-key resolution request.
 *
 * @param chatMid - Group chat MID
 * @param receiverKeyId - Expected receiver key id
 * @returns Stable in-flight fetch key
 */
function getGroupKeyFetchKey(chatMid: string, receiverKeyId: string): string {
  return `${chatMid}:${receiverKeyId}`
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
  const {
    creator,
    creatorKeyId,
    sharedReceiverKeyId,
    encryptedSharedKey,
    groupKeyId,
  } = extractSharedKeyFields(shared, receiverKeyId, senderMid, senderKeyId)

  const selfKey = ctx.getSelfKeyById(sharedReceiverKeyId)
  if (!selfKey) {
    ctx.raiseWarning('missing_self_key', {
      receiverKeyId: sharedReceiverKeyId,
      chatMid,
    })
    throw new Error(
      `Missing self E2EE key for receiverKeyId=${sharedReceiverKeyId}`,
    )
  }
  if (!creator || !creatorKeyId || !encryptedSharedKey) {
    throw new Error('Incomplete group shared key payload')
  }

  const selfMid = ctx.getProfileMid()
  const creatorPublicKey =
    creator === selfMid
      ? selfKey.publicKey
      : await getPeerPublicKey(ctx, creator, creatorKeyId)
  const aesSecret = computeSharedSecret(selfKey.privateKey, creatorPublicKey)
  const { key, iv } = deriveKeyAndIV(aesSecret)
  const raw = encryptedSharedKey as any
  const encrypted = Buffer.isBuffer(raw)
    ? raw
    : Buffer.from(raw, typeof raw === 'string' ? 'base64' : undefined)
  const plainText = aesDecrypt(encrypted, key, iv)
  const groupKey: GroupKey = { keyId: groupKeyId, privateKey: plainText }

  // Cache under (chat, groupKeyId) — only ever add, never overwrite a
  // different epoch, so a later rekey cannot strand messages this device can
  // already read.
  const cacheKey = `${chatMid}:${groupKey.keyId}`
  ctx.groupKeys.set(cacheKey, groupKey)
  const store = ctx.getStore()
  await store?.set?.(
    `line_e2ee_group_by_mid:${cacheKey}`,
    JSON.stringify({
      keyId: groupKey.keyId,
      privateKey: groupKey.privateKey.toString('base64'),
    }),
  )
  ctx.logGroupKeyEvent('e2ee.group_key.resolved', {
    chat: chatMid,
    source: resolutionSource,
    receiver_key_id: sharedReceiverKeyId,
    creator,
    creator_key_id: creatorKeyId,
    group_key_id: groupKeyId,
    encrypted_shared_key_bytes: encrypted.length,
  })
  return groupKey
}

/**
 * Resolve and cache the group shared key for a chat.
 *
 * Yomi is read/send-only over group keys: it resolves an EXISTING shared key
 * or returns undefined. It NEVER registers (mints) a group key. Minting is an
 * account-visible write that rotates the group's shared secret for every
 * member; every message encrypted under the previous secret — all of it, for
 * every sender — then fails to decrypt, and members who don't adopt the new
 * secret are stranded too. Group-key lifecycle belongs to the official LINE
 * clients / the primary device, never to Yomi.
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
    const cachedLatest = await lookupCachedGroupKey(ctx, chatMid, null)
    if (cachedLatest) {
      return cachedLatest
    }
  }

  const cached = await lookupCachedGroupKey(ctx, chatMid, receiverKeyId)
  if (cached) {
    return cached
  }

  const resolvedReceiverKeyId = receiverKeyId || 'latest'
  const fetchKey = getGroupKeyFetchKey(chatMid, resolvedReceiverKeyId)
  const inflight = ctx.groupKeyFetches.get(fetchKey)
  if (inflight) {
    ctx.logGroupKeyEvent('e2ee.group_key.fetch_join', {
      chat: chatMid,
      receiver_key_id: receiverKeyId,
      inflight_receiver_key_id: inflight.receiverKeyId,
    })
    return inflight.promise
  }

  const fetchPromise = (async () => {
    const client = ctx.getClient()
    let shared: any
    let resolutionSource = 'server_fetch'
    try {
      shared = await client?.getLastE2EEGroupSharedKey?.(2, chatMid)
    } catch (error: any) {
      const code =
        typeof error?.data?.code === 'string' ? error.data.code : null
      const message: string = error?.message || String(error)
      const shouldFallback =
        code === 'NOT_FOUND' ||
        message.toLowerCase().includes('no valid group key')
      if (!shouldFallback) {
        ctx.logGroupKeyEvent('e2ee.group_key.fetch_failed', {
          chat: chatMid,
          receiver_key_id: receiverKeyId,
          code,
          error: message,
        })
        throw error
      }
      resolutionSource = 'register_fallback'
    }
    if (!shared) {
      // Yomi never mints. LINE has no readable group key for this
      // (receiverKeyId, chat) — fail cleanly rather than register one and
      // rotate the group's secret out from under every other member.
      ctx.logGroupKeyEvent('e2ee.group_key.mint_suppressed', {
        chat: chatMid,
        receiver_key_id: receiverKeyId,
      })
    }
    if (!shared) {
      ctx.logGroupKeyEvent('e2ee.group_key.unavailable', {
        chat: chatMid,
        receiver_key_id: receiverKeyId,
        source: resolutionSource,
      })
      return undefined
    }

    return deriveAndCacheGroupKey(
      ctx,
      chatMid,
      shared,
      resolvedReceiverKeyId,
      senderMid,
      senderKeyId,
      resolutionSource,
    )
  })()

  ctx.groupKeyFetches.set(fetchKey, {
    receiverKeyId: resolvedReceiverKeyId,
    promise: fetchPromise,
  })
  try {
    return await fetchPromise
  } finally {
    ctx.groupKeyFetches.delete(fetchKey)
  }
}

export { normalizeGroupPublicKeys } from './key-payload.js'
