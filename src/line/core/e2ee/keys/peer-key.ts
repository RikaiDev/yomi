import type { KeyManagerContext, PeerPublicKeyCandidate } from './key-types.js';
import { Buffer } from 'node:buffer';
import { normalizeGroupPublicKeys, normalizeNegotiatedPublicKey } from './key-payload.js';

/**
 * Resolve and cache a peer public key by MID and key ID.
 * @param ctx - KeyManager context
 * @param mid - Peer LINE MID
 * @param keyId - Expected peer key ID
 * @returns Peer public key bytes
 */
export async function getPeerPublicKey(ctx: KeyManagerContext, mid: string, keyId: string): Promise<Buffer> {
  const cacheKey = `peer:${keyId}`;
  if (ctx.peerPublicKeys.has(cacheKey)) {
    ctx.logGroupKeyEvent('e2ee.peer_key.cache_hit', { mid, key_id: keyId, source: 'memory' });
    return ctx.peerPublicKeys.get(cacheKey) as Buffer;
  }

  const store = ctx.getStore();
  const persisted = await store?.get?.(`line_e2ee_public_by_keyid:${keyId}`);
  if (persisted) {
    const parsed = JSON.parse(persisted);
    const data = Buffer.from(parsed.keyData, 'base64');
    ctx.peerPublicKeys.set(cacheKey, data);
    ctx.logGroupKeyEvent('e2ee.peer_key.cache_hit', { mid, key_id: keyId, source: 'persisted' });
    return data;
  }

  const client = ctx.getClient();
  const publicKey = normalizeNegotiatedPublicKey(await client?.negotiateE2EEPublicKey?.(mid));
  const negotiatedKeyId = publicKey?.keyId;
  const keyData = publicKey?.keyData;
  if (!keyData || String(negotiatedKeyId) !== String(keyId)) {
    ctx.logGroupKeyEvent('e2ee.peer_key.fetch_failed', {
      mid,
      key_id: keyId,
      negotiated_key_id: negotiatedKeyId ?? null,
    });
    throw new Error(`Peer E2EE key mismatch for ${mid}: expected=${keyId}, actual=${String(negotiatedKeyId)}`);
  }

  ctx.peerPublicKeys.set(cacheKey, keyData);
  ctx.logGroupKeyEvent('e2ee.peer_key.resolved', { mid, key_id: keyId, source: 'server_fetch' });
  await persistPeerPublicKey(ctx, mid, String(keyId), keyData);
  return keyData;
}

/**
 * Persist one peer public key by key id and append it to the sender history.
 *
 * @param ctx - KeyManager context
 * @param mid - Sender MID
 * @param keyId - Public key id
 * @param data - 32-byte public key
 */
export async function persistPeerPublicKey(ctx: KeyManagerContext, mid: string, keyId: string, data: Buffer): Promise<void> {
  const store = ctx.getStore();
  const record = JSON.stringify({ mid, keyId, keyData: data.toString('base64') });

  const existing = await store?.get?.(`line_e2ee_public_by_keyid:${keyId}`);
  if (existing !== record) {
    await store?.set?.(`line_e2ee_public_by_keyid:${keyId}`, record);
  }

  const historyKey = `line_e2ee_public_history_by_mid:${mid}`;
  const rawHistory = await store?.get?.(historyKey);
  let history: Array<{ mid: string; keyId: string; keyData: string }> = [];
  if (rawHistory) {
    try {
      const parsed = JSON.parse(rawHistory);
      if (Array.isArray(parsed)) {
        history = parsed.filter(Boolean);
      }
    }
    catch {
      history = [];
    }
  }

  const nextHistory = [
    { mid, keyId, keyData: data.toString('base64') },
    ...history.filter(entry => String(entry?.keyId) !== keyId),
  ].slice(0, 8);
  await store?.set?.(historyKey, JSON.stringify(nextHistory));
}

/**
 * Append the live group-member-map key as the first sender candidate.
 *
 * @param ctx - KeyManager context.
 * @param chatMid - Group chat MID.
 * @param senderMid - Sender MID.
 * @param senderKey - Sender key from LINE group-member map.
 * @param candidates - Mutable candidate collection.
 */
async function appendLiveSenderCandidate(
  ctx: KeyManagerContext,
  chatMid: string,
  senderMid: string,
  senderKey: { keyData: Buffer; keyId: string | number } | undefined,
  candidates: PeerPublicKeyCandidate[],
): Promise<void> {
  if (!senderKey) {
    return;
  }
  const data = senderKey.keyData;
  ctx.peerPublicKeys.set(`peer:${senderKey.keyId}`, data);
  await persistPeerPublicKey(ctx, senderMid, String(senderKey.keyId), data);
  ctx.logGroupKeyEvent('e2ee.peer_key.resolved', {
    mid: senderMid,
    key_id: senderKey.keyId,
    source: 'group_member_key_map',
    chat: chatMid,
  });
  candidates.push({
    keyId: String(senderKey.keyId),
    keyData: data,
    source: 'group_member_key_map',
  });
}

/**
 * Append persisted sender history keys that are not duplicates.
 *
 * @param ctx - KeyManager context.
 * @param senderMid - Sender MID.
 * @param candidates - Mutable candidate collection.
 */
async function appendHistoricalSenderCandidates(
  ctx: KeyManagerContext,
  senderMid: string,
  candidates: PeerPublicKeyCandidate[],
): Promise<void> {
  const store = ctx.getStore();
  const rawHistory = await store?.get?.(`line_e2ee_public_history_by_mid:${senderMid}`);
  const parsed: unknown = rawHistory ? JSON.parse(rawHistory) : null;
  const entries = Array.isArray(parsed) ? parsed : [];
  for (const entry of entries) {
    const keyData = (entry as any)?.keyData;
    if (typeof keyData !== 'string') {
      continue;
    }
    const buffer = Buffer.from(keyData, 'base64');
    const historyKeyId = String((entry as any)?.keyId || '');
    if (!historyKeyId) {
      continue;
    }
    if (!candidates.some(candidate => candidate.keyId === historyKeyId || candidate.keyData.equals(buffer))) {
      candidates.push({
        keyId: historyKeyId,
        keyData: buffer,
        source: 'history',
      });
    }
  }
}

/**
 * Resolve sender public key candidates for a group message.
 *
 * Prefers an explicit sender key from the group member key map.
 * Falls back to the persisted sender key history when that field is absent.
 *
 * @param ctx - KeyManager context
 * @param chatMid - Group or room MID
 * @param senderMid - Sender MID
 * @returns Candidate sender public key buffers
 */
export async function getGroupSenderPublicKeyCandidates(
  ctx: KeyManagerContext,
  chatMid: string,
  senderMid: string,
): Promise<PeerPublicKeyCandidate[]> {
  ctx.logGroupKeyEvent('e2ee.message.sender_key_id_fallback', {
    chat: chatMid,
    sender: senderMid,
    strategy: 'group_member_key_map_then_history',
  });

  const client = ctx.getClient();
  const keyMap = normalizeGroupPublicKeys(await client?.getLastE2EEPublicKeys?.(chatMid));
  const senderKey = keyMap.get(senderMid);
  const candidates: PeerPublicKeyCandidate[] = [];
  await appendLiveSenderCandidate(ctx, chatMid, senderMid, senderKey, candidates);
  try {
    await appendHistoricalSenderCandidates(ctx, senderMid, candidates);
  }
  catch {
    // Ignore malformed history and continue with currently known keys only.
  }

  if (candidates.length === 0) {
    ctx.logGroupKeyEvent('e2ee.message.missing_sender_key_id', {
      chat: chatMid,
      sender: senderMid,
      sender_key_id: null,
      receiver_key_id: null,
      strategy: 'group_member_key_map_miss',
    });
    throw new Error(`Missing group sender key for ${senderMid} in ${chatMid}`);
  }
  return candidates;
}
