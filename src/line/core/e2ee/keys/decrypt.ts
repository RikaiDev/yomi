import type { KeyManagerContext } from './key-types.js'
import { tryDecryptInner } from './message-decrypt.js'

const PEER_KEY_MISMATCH_PATTERN = /Peer E2EE key mismatch/i
const MISSING_GROUP_SENDER_KEY_PATTERN = /Missing group sender key/i
const GCM_AUTH_FAILURE_PATTERN =
  /unable to authenticate data|Unsupported state or unable to authenticate/i

/**
 * Build one structured decrypt-failure log payload from a raw LINE message.
 *
 * @param ctx - KeyManager context.
 * @param msg - Raw LINE message object.
 * @param error - Thrown decryption error.
 * @returns Structured log context.
 */
function buildDecryptFailureContext(
  ctx: KeyManagerContext,
  msg: any,
  error: Error,
): Record<string, unknown> {
  const chatMid = resolveDecryptFailureChatMid(msg)
  return {
    chat: chatMid,
    message_id: msg?.id ?? null,
    sender: msg?.from ?? null,
    to: msg?.to ?? null,
    sender_key_id: readDecryptFailureChunkKeyId(ctx, msg, 3),
    receiver_key_id: readDecryptFailureChunkKeyId(ctx, msg, 4),
    content_type: msg?.contentType ?? null,
    e2ee_version: msg?.contentMetadata?.e2eeVersion ?? null,
    error: error.message,
  }
}

/**
 * Convert one thrown decrypt error into a stable reason code.
 *
 * @param error - Thrown decrypt error.
 * @returns Diagnostic reason code.
 */
function resolveDecryptFailureReason(error: Error): string {
  if (PEER_KEY_MISMATCH_PATTERN.test(error.message)) {
    return 'peer_key_mismatch'
  }
  if (MISSING_GROUP_SENDER_KEY_PATTERN.test(error.message)) {
    return 'missing_group_sender_key'
  }
  if (GCM_AUTH_FAILURE_PATTERN.test(error.message)) {
    return 'gcm_auth_failed'
  }
  return 'decrypt_failed'
}

/**
 * Resolve the group chat MID for one failed decrypt attempt.
 *
 * @param msg - Raw LINE message object.
 * @returns Group chat MID or null.
 */
function resolveDecryptFailureChatMid(msg: any): string | null {
  const isGroup = Number(msg?.toType) !== 0
  return isGroup && typeof msg?.to === 'string' ? msg.to : null
}

/**
 * Read one parsed LINE E2EE chunk key id from a failed decrypt payload.
 *
 * @param ctx - KeyManager context.
 * @param msg - Raw LINE message object.
 * @param index - Chunk index.
 * @returns Parsed chunk key id or null.
 */
function readDecryptFailureChunkKeyId(
  ctx: KeyManagerContext,
  msg: any,
  index: number,
): string | null {
  if (typeof ctx.readChunkKeyId !== 'function') {
    return null
  }
  return ctx.readChunkKeyId(msg?.chunks?.[index])
}

/**
 * Handle one E2EE decrypt failure without escalating to auth/session state.
 *
 * @param ctx - KeyManager context.
 * @param msg - Raw LINE message object.
 * @param error - Thrown decryption error.
 * @returns Stable failed decrypt result.
 */
async function handleDecryptFailure(
  ctx: KeyManagerContext,
  msg: any,
  error: Error,
): Promise<{
  decrypted: boolean
  text?: string
  reason?: string
  error?: string
  senderKeyId?: string | null
  receiverKeyId?: string | null
}> {
  // Do NOT invalidate the group key on failure. Keys are cached per epoch
  // (chat:groupKeyId) and are never the wrong secret for their id; a group
  // decrypt failure means the message's epoch is one LINE can no longer hand
  // us (it only returns the latest), which a refetch cannot fix. Dropping the
  // key here would only evict epochs this device can still read and churn the
  // credential store.
  ctx.logGroupKeyEvent?.(
    'e2ee.message.decrypt_failed',
    buildDecryptFailureContext(ctx, msg, error),
  )
  console.warn('[E2EE] Decryption failed:', error.message)
  return {
    decrypted: false,
    error: error.message,
    reason: resolveDecryptFailureReason(error),
    receiverKeyId: readDecryptFailureChunkKeyId(ctx, msg, 4),
    senderKeyId: readDecryptFailureChunkKeyId(ctx, msg, 3),
  }
}

/**
 * Attempt to decrypt an E2EE message using stored keys.
 * Returns plaintext on success, or a no-op result for plaintext messages.
 *
 * @param ctx - KeyManager context
 * @param msg - Parsed message object (from parsers.ts)
 * @returns Decryption result with optional plaintext
 */
export async function tryDecrypt(
  ctx: KeyManagerContext,
  msg: any,
): Promise<{ decrypted: boolean; text?: string }> {
  try {
    return await tryDecryptInner(ctx, msg)
  } catch (err) {
    return handleDecryptFailure(ctx, msg, err as Error)
  }
}
