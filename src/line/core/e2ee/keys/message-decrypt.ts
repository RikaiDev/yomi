import { Buffer } from 'node:buffer'
import { computeSharedSecret } from '../crypto/crypto-primitives.js'
import { getGroupKey } from './group-key.js'
import type { KeyManagerContext, PeerPublicKeyCandidate } from './key-types.js'
import {
  decryptV1,
  decryptV2,
  decryptV2WithCandidates,
  extractTextPayload,
  generateAAD,
  toChunkKeyId,
} from './message-crypto.js'
import {
  getGroupSenderPublicKeyCandidates,
  getPeerPublicKey,
} from './peer-key.js'

export interface E2EEChunks {
  salt: Buffer
  ciphertext: Buffer
  sign: Buffer
  version: string
  senderKeyId: string | null
  receiverKeyId: string | null
  toType: number
  isUserChat: boolean
  chatMid: string | null
  isSelf: boolean
}

interface DecryptKeys {
  privateKey: Buffer | Uint8Array
  publicKey: Buffer | Uint8Array | undefined
  candidatePublicKeys: PeerPublicKeyCandidate[] | null
  resolvedReceiverKeyId: string | null
}

interface PreparedDecryptPayload {
  chunks: E2EEChunks
  msg: any
}

interface DecryptResult {
  decrypted: boolean
  text?: string
  reason?: string
  envelopeInfo?: Record<string, unknown> | null
  senderKeyId?: string | null
  receiverKeyId?: string | null
  toType?: number | null
  isUserChat?: boolean
  isSelf?: boolean
}

/**
 * Emit one structured log when the decrypt path still lacks sender/self keys.
 *
 * @param ctx - KeyManager context.
 * @param msg - Raw LINE message.
 * @param chatMid - Group chat MID when applicable.
 * @param senderKeyId - Parsed sender key id.
 * @param receiverKeyId - Parsed receiver/group key id.
 * @param isUserChat - Whether the message came from a 1:1 chat.
 * @param isSelf - Whether the sender is the authenticated user.
 */
function logMissingDecryptKeys(
  ctx: KeyManagerContext,
  msg: any,
  chatMid: string | null,
  senderKeyId: string | null,
  receiverKeyId: string | null,
  isUserChat: boolean,
  isSelf: boolean,
): void {
  ctx.logGroupKeyEvent('e2ee.message.decrypt_missing_keys', {
    chat: chatMid,
    message_id: msg.id || null,
    sender: msg.from || null,
    sender_key_id: senderKeyId,
    receiver_key_id: receiverKeyId,
    to_type: msg.toType ?? null,
    is_user_chat: isUserChat,
    is_self: isSelf,
  })
}

/**
 * Check whether the resolved decrypt material is sufficient to proceed.
 *
 * @param resolved - Resolved decrypt keys.
 * @returns True when a direct sender key or fallback candidates exist.
 */
function hasDecryptMaterial(resolved: DecryptKeys | null): boolean {
  return (
    Boolean(resolved?.publicKey) ||
    (resolved?.candidatePublicKeys?.length ?? 0) > 0
  )
}

/**
 * Parse E2EE chunk data from a raw message object.
 *
 * @param ctx - KeyManager context
 * @param msg - Raw message object
 * @returns Parsed E2EE chunk data, or null if the message is not E2EE
 */
export function parseE2EEChunks(
  ctx: KeyManagerContext,
  msg: any,
): E2EEChunks | null {
  const chunks = msg.chunks
  if (!chunks || !Array.isArray(chunks) || chunks.length < 5) {
    return null
  }
  const toType = Number(msg.toType)
  const isUserChat = toType === 0
  return {
    salt: Buffer.from(chunks[0]),
    ciphertext: Buffer.from(chunks[1]),
    sign: Buffer.from(chunks[2]),
    version: String(msg.contentMetadata?.e2eeVersion || '2'),
    senderKeyId: toChunkKeyId(chunks[3]),
    receiverKeyId: toChunkKeyId(chunks[4]),
    toType,
    isUserChat,
    chatMid: !isUserChat && typeof msg.to === 'string' ? msg.to : null,
    isSelf: Boolean(msg.from && ctx.getProfileMid() === msg.from),
  }
}

/**
 * Read one field from an E2EEMessageInfo response across decoded shapes.
 *
 * @param info - Decoded E2EEMessageInfo payload.
 * @param namedKey - Object key used by typed decoders.
 * @param tupleIndex - Numeric field id used by thrift tuple decoders.
 * @returns Field value when available.
 */
function readMessageInfoField(
  info: any,
  namedKey: string,
  tupleIndex: number,
): any {
  return (
    info?.[namedKey] ?? info?.[tupleIndex] ?? info?.fields?.[tupleIndex] ?? null
  )
}

/**
 * Check whether a user-chat E2EE payload needs message-info enrichment.
 *
 * @param msg - Raw LINE message.
 * @param chunks - Parsed chunk metadata.
 * @returns Whether the envelope is missing the peer key id.
 */
function shouldFetchMessageInfoEnvelope(msg: any, chunks: E2EEChunks): boolean {
  if (
    !chunks.isUserChat ||
    chunks.isSelf ||
    chunks.senderKeyId ||
    !chunks.receiverKeyId
  ) {
    return false
  }
  return Boolean(msg?.id && msg?.from)
}

/**
 * Attach message-info enrichment diagnostics to a message clone.
 *
 * @param msg - Raw LINE message.
 * @param envelopeInfo - Diagnostic payload.
 * @returns Message carrying the enrichment diagnostics.
 */
function withEnvelopeInfo(
  msg: any,
  envelopeInfo: Record<string, unknown>,
): any {
  return {
    ...msg,
    e2eeEnvelopeInfo: envelopeInfo,
  }
}

/**
 * Fetch a complete E2EE message envelope when history payload omitted key ids.
 *
 * @param ctx - KeyManager context.
 * @param msg - Raw LINE message.
 * @param chunks - Parsed chunk metadata.
 * @returns Message with enriched envelope when LINE provides it.
 */
async function enrichMissingUserEnvelope(
  ctx: KeyManagerContext,
  msg: any,
  chunks: E2EEChunks,
): Promise<PreparedDecryptPayload> {
  if (!shouldFetchMessageInfoEnvelope(msg, chunks)) {
    return { chunks, msg }
  }
  const getMessageInfo = ctx.getClient()?.getE2EEMessageInfo
  if (typeof getMessageInfo !== 'function') {
    return {
      chunks,
      msg: withEnvelopeInfo(msg, {
        attempted: false,
        reason: 'client_method_unavailable',
      }),
    }
  }
  let info: any = null
  try {
    info = await getMessageInfo(msg.from, msg.id, Number(chunks.receiverKeyId))
  } catch (error) {
    return {
      chunks,
      msg: withEnvelopeInfo(msg, {
        attempted: true,
        error: error instanceof Error ? error.message : String(error),
        reason: 'message_info_fetch_failed',
      }),
    }
  }
  const infoChunks = readMessageInfoField(info, 'chunks', 3)
  if (!Array.isArray(infoChunks) || infoChunks.length < 5) {
    return {
      chunks,
      msg: withEnvelopeInfo(msg, {
        attempted: true,
        reason: 'message_info_missing_chunks',
        responseType: info == null ? 'null' : typeof info,
      }),
    }
  }
  const enrichedMsg = {
    ...msg,
    chunks: infoChunks,
    contentMetadata:
      readMessageInfoField(info, 'contentMetadata', 2) || msg.contentMetadata,
    contentType:
      readMessageInfoField(info, 'contentType', 1) ?? msg.contentType,
    e2eeEnvelopeInfo: {
      attempted: true,
      chunkCount: infoChunks.length,
      reason: 'message_info_enriched',
    },
  }
  const enrichedChunks = parseE2EEChunks(ctx, enrichedMsg)
  return enrichedChunks
    ? { chunks: enrichedChunks, msg: enrichedMsg }
    : { chunks, msg }
}

/**
 * Resolve the self key that matches the E2EE envelope.
 *
 * @param ctx - KeyManager context.
 * @param selfMid - Current LINE profile MID.
 * @param chunks - Parsed E2EE chunk data.
 * @returns Matching imported self key.
 */
function resolveSelfKey(
  ctx: KeyManagerContext,
  selfMid: string,
  chunks: E2EEChunks,
): NonNullable<ReturnType<KeyManagerContext['getSelfKeyByMid']>> | undefined {
  const envelopeSelfKeyId = chunks.isSelf
    ? chunks.senderKeyId
    : chunks.receiverKeyId
  if (envelopeSelfKeyId) {
    return ctx.getSelfKeyById(envelopeSelfKeyId) || ctx.getSelfKeyByMid(selfMid)
  }
  return ctx.getSelfKeyByMid(selfMid)
}

/**
 * Resolve group sender public key for a non-self group message.
 *
 * @param ctx - KeyManager context
 * @param msg - Raw message object
 * @param chatMid - Group chat MID
 * @param senderKeyId - Sender key ID
 * @returns Public key or candidate list, or null when missing
 */
async function resolveGroupSenderKey(
  ctx: KeyManagerContext,
  msg: any,
  chatMid: string,
  senderKeyId: string | null,
): Promise<{
  publicKey?: Buffer
  candidatePublicKeys?: PeerPublicKeyCandidate[] | null
} | null> {
  if (!msg.from) {
    ctx.logGroupKeyEvent('e2ee.message.missing_sender_key_id', {
      chat: chatMid,
      sender: null,
      sender_key_id: senderKeyId,
      receiver_key_id: null,
    })
    return null
  }
  if (senderKeyId) {
    return {
      publicKey: await getPeerPublicKey(ctx, msg.from, senderKeyId),
      candidatePublicKeys: null,
    }
  }
  const candidatePublicKeys = chatMid
    ? await getGroupSenderPublicKeyCandidates(ctx, chatMid, msg.from)
    : []
  return { candidatePublicKeys, publicKey: undefined }
}

/**
 * Resolve keys for decryption based on chat type and message metadata.
 *
 * @param ctx - KeyManager context
 * @param msg - Raw message object
 * @param selfKey - Authenticated user's self key
 * @param isUserChat - True for 1:1 chats
 * @param isSelf - True when the message sender is the authenticated user
 * @param chatMid - Group chat MID (null for 1:1)
 * @param senderKeyId - Sender key ID from message chunks
 * @param receiverKeyId - Receiver key ID from message chunks
 * @returns Resolved keys or null when decryption cannot proceed
 */
async function resolveDecryptKeys(
  ctx: KeyManagerContext,
  msg: any,
  selfKey: NonNullable<ReturnType<KeyManagerContext['getSelfKeyByMid']>>,
  isUserChat: boolean,
  isSelf: boolean,
  chatMid: string | null,
  senderKeyId: string | null,
  receiverKeyId: string | null,
): Promise<DecryptKeys | null> {
  if (isUserChat) {
    const peerMid = isSelf ? msg.to : msg.from
    const peerKeyId = isSelf ? receiverKeyId : senderKeyId
    if (!peerMid || !peerKeyId) {
      return null
    }
    return {
      privateKey: selfKey.privateKey,
      publicKey: await getPeerPublicKey(ctx, peerMid, peerKeyId),
      candidatePublicKeys: null,
      resolvedReceiverKeyId: receiverKeyId,
    }
  }
  const groupKey = chatMid
    ? await getGroupKey(ctx, chatMid, receiverKeyId, msg.from, senderKeyId)
    : undefined
  if (!groupKey) {
    return {
      privateKey: selfKey.privateKey,
      publicKey: undefined,
      candidatePublicKeys: null,
      resolvedReceiverKeyId: receiverKeyId,
    }
  }
  ctx.logGroupKeyEvent('e2ee.message.decrypt_context', {
    chat: chatMid,
    message_id: msg.id || null,
    sender: msg.from || null,
    sender_key_id: senderKeyId,
    message_group_key_id: receiverKeyId,
    resolved_group_key_id: groupKey.keyId,
    is_self: isSelf,
  })
  if (isSelf) {
    return {
      privateKey: groupKey.privateKey,
      publicKey: Buffer.from(selfKey.publicKey),
      candidatePublicKeys: null,
      resolvedReceiverKeyId: groupKey.keyId,
    }
  }
  const senderKeys = await resolveGroupSenderKey(
    ctx,
    msg,
    chatMid!,
    senderKeyId,
  )
  if (!senderKeys) {
    return null
  }
  return {
    privateKey: groupKey.privateKey,
    publicKey: senderKeys.publicKey,
    candidatePublicKeys: senderKeys.candidatePublicKeys ?? null,
    resolvedReceiverKeyId: groupKey.keyId,
  }
}

/**
 * Decrypt the ciphertext using the resolved keys and return plaintext.
 *
 * @param msg - Raw message object
 * @param chunks - Parsed E2EE chunk data
 * @param privateKey - Decryption private key
 * @param publicKey - Peer public key
 * @param candidatePublicKeys - Candidate public keys for group sender fallback
 * @param resolvedReceiverKeyId - Effective receiver/group key id used for AAD
 * @returns Decrypted plaintext string
 */
export function performDecrypt(
  msg: any,
  chunks: E2EEChunks,
  privateKey: Buffer | Uint8Array,
  publicKey: Buffer | Uint8Array | undefined,
  candidatePublicKeys: PeerPublicKeyCandidate[] | null,
  resolvedReceiverKeyId: string | null,
): string {
  const { salt, ciphertext, sign, version, senderKeyId, receiverKeyId } = chunks
  if (version !== '2') {
    return extractTextPayload(
      decryptV1(computeSharedSecret(privateKey, publicKey!), salt, ciphertext),
    )
  }
  const effectiveReceiverKeyId = Number(
    resolvedReceiverKeyId || receiverKeyId || 0,
  )
  const buildAAD = (effectiveSenderKeyId: string | null) =>
    generateAAD(
      String(msg.to || ''),
      String(msg.from || ''),
      Number(effectiveSenderKeyId || senderKeyId || 0),
      effectiveReceiverKeyId,
      Number(version || 2),
      Number(msg.contentType || 0),
    )
  if (candidatePublicKeys && candidatePublicKeys.length > 0) {
    return extractTextPayload(
      decryptV2WithCandidates(
        privateKey,
        candidatePublicKeys,
        salt,
        ciphertext,
        sign,
        (candidate) => buildAAD(candidate.keyId),
      ),
    )
  }
  return extractTextPayload(
    decryptV2(
      computeSharedSecret(privateKey, publicKey!),
      salt,
      ciphertext,
      sign,
      buildAAD(senderKeyId),
    ),
  )
}

/**
 * Build a stable failed decrypt result when the message still lacks keys.
 *
 * @param ctx - KeyManager context.
 * @param msg - Raw LINE message.
 * @param chunks - Parsed E2EE chunks.
 * @returns Stable failed decrypt result.
 */
function buildMissingDecryptResult(
  ctx: KeyManagerContext,
  msg: any,
  chunks: E2EEChunks,
): DecryptResult {
  const { isUserChat, isSelf, chatMid, senderKeyId, receiverKeyId, version } =
    chunks
  console.warn(
    `[E2EE] No stored key: version=${version}, senderKeyId=${senderKeyId}, receiverKeyId=${receiverKeyId}, toType=${String(msg.toType)}`,
  )
  logMissingDecryptKeys(
    ctx,
    msg,
    chatMid,
    senderKeyId,
    receiverKeyId,
    isUserChat,
    isSelf,
  )
  return {
    decrypted: false,
    envelopeInfo: msg.e2eeEnvelopeInfo || null,
    isSelf,
    isUserChat,
    reason: 'missing_decrypt_material',
    receiverKeyId,
    senderKeyId,
    toType: chunks.toType,
  }
}

/**
 * Execute the E2EE decryption pipeline — parse chunks, resolve keys, decrypt.
 * Separated from tryDecrypt to keep the outer try-catch minimal.
 *
 * @param ctx - KeyManager context
 * @param msg - Parsed message object
 * @returns Decryption result with optional plaintext
 */
export async function tryDecryptInner(
  ctx: KeyManagerContext,
  msg: any,
): Promise<DecryptResult> {
  const parsedChunks = parseE2EEChunks(ctx, msg)
  if (!parsedChunks) {
    return { decrypted: false, reason: 'missing_chunks' }
  }
  const prepared = await enrichMissingUserEnvelope(ctx, msg, parsedChunks)
  const { chunks } = prepared
  const decryptMsg = prepared.msg
  const selfMid = ctx.getProfileMid()
  if (!selfMid) {
    return {
      decrypted: false,
      isSelf: chunks.isSelf,
      isUserChat: chunks.isUserChat,
      reason: 'missing_profile_mid',
      receiverKeyId: chunks.receiverKeyId,
      senderKeyId: chunks.senderKeyId,
      toType: chunks.toType,
    }
  }
  const selfKey = resolveSelfKey(ctx, selfMid, chunks)
  if (!selfKey) {
    ctx.raiseWarning('missing_self_key', { profileMid: selfMid })
    return {
      decrypted: false,
      isSelf: chunks.isSelf,
      isUserChat: chunks.isUserChat,
      reason: 'missing_self_key',
      receiverKeyId: chunks.receiverKeyId,
      senderKeyId: chunks.senderKeyId,
      toType: chunks.toType,
    }
  }
  const { isUserChat, isSelf, chatMid, senderKeyId, receiverKeyId } = chunks
  const resolved = await resolveDecryptKeys(
    ctx,
    decryptMsg,
    selfKey,
    isUserChat,
    isSelf,
    chatMid,
    senderKeyId,
    receiverKeyId,
  )
  if (!hasDecryptMaterial(resolved)) {
    return buildMissingDecryptResult(ctx, decryptMsg, chunks)
  }
  return {
    decrypted: true,
    text: performDecrypt(
      decryptMsg,
      chunks,
      resolved!.privateKey,
      resolved!.publicKey,
      resolved?.candidatePublicKeys ?? null,
      resolved?.resolvedReceiverKeyId ?? receiverKeyId,
    ),
  }
}
