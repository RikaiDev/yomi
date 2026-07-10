import type { NegotiatedPublicKey, RawNegotiatedPublicKeyShape } from './key-types.js';
import { Buffer } from 'node:buffer';

/**
 * Read one normalized field from a negotiated public-key candidate payload.
 *
 * @param candidate - Raw candidate payload.
 * @param fieldId - Target thrift field id.
 * @returns Raw field value or null.
 */
function readCandidateField(candidate: RawNegotiatedPublicKeyShape | null | undefined, fieldId: 2 | 4): unknown {
  if (!candidate) {
    return null;
  }

  if (fieldId === 2) {
    return candidate[2] ?? candidate.keyId ?? candidate.publicKey?.[2] ?? candidate.publicKey?.keyId ?? null;
  }

  return candidate[4] ?? candidate.keyData ?? candidate.publicKey?.[4] ?? candidate.publicKey?.keyData ?? null;
}

/**
 * Select the nested object that actually contains public key fields.
 *
 * @param raw - Raw negotiation response from LINE.
 * @returns Normalized container object.
 */
function readPublicKeyContainer(raw: any): any {
  return raw?.[2] || raw?.publicKey || raw?.fields?.[2] || raw || null;
}

/**
 * Read one normalized field from the selected negotiated public-key container.
 *
 * @param publicKey - Selected public-key container.
 * @param raw - Raw negotiation response.
 * @param fieldId - Target thrift field id.
 * @returns Raw field value or null.
 */
function readNegotiatedValue(publicKey: any, raw: any, fieldId: 2 | 4): unknown {
  if (fieldId === 2) {
    return publicKey?.[2] ?? publicKey?.keyId ?? raw?.keyId ?? null;
  }

  return publicKey?.[4] ?? publicKey?.keyData ?? raw?.keyData ?? null;
}

/**
 * Normalize raw key payloads into Buffer instances.
 *
 * @param keyData - Raw key payload from thrift or object responses.
 * @returns Buffer instance or null when unsupported.
 */
export function toKeyBuffer(keyData: unknown): Buffer | null {
  if (Buffer.isBuffer(keyData)) {
    return keyData;
  }
  if (typeof keyData === 'string') {
    return Buffer.from(keyData, 'base64');
  }
  if (keyData instanceof Uint8Array) {
    return Buffer.from(keyData);
  }
  if (keyData instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(keyData));
  }
  return null;
}

/**
 * Normalize the getLastE2EEPublicKeys response into a member->public-key map.
 *
 * linejs treats this response as an object keyed by member MID. Depending on
 * our thrift decoder shape it may arrive as a plain object or as nested field
 * tuples, so this helper accepts both and extracts only the fields required to
 * register a new group key.
 *
 * @param raw - Raw getLastE2EEPublicKeys response
 * @returns Map of member MID to key metadata
 */
export function normalizeGroupPublicKeys(raw: any): Map<string, NegotiatedPublicKey> {
  const result = new Map<string, NegotiatedPublicKey>();
  const entries = raw && typeof raw === 'object' ? Object.entries(raw) : [];
  for (const [mid, value] of entries) {
    const candidate = value as RawNegotiatedPublicKeyShape | null | undefined;
    const keyId = readCandidateField(candidate, 2);
    const keyData = readCandidateField(candidate, 4);
    if (keyId == null || !keyData) {
      continue;
    }
    const normalizedKeyData = toKeyBuffer(keyData);
    if (!normalizedKeyData) {
      continue;
    }
    result.set(String(mid), { keyId: String(keyId), keyData: normalizedKeyData });
  }
  return result;
}

/**
 * Normalize a negotiateE2EEPublicKey response into the key shape used by the
 * local runtime. LINE returns slightly different nested structs depending on
 * endpoint version and thrift decoder shape; this helper accepts either.
 *
 * @param raw - Raw negotiation response from the LINE Talk service
 * @returns Normalized key payload or null
 */
export function normalizeNegotiatedPublicKey(raw: any): NegotiatedPublicKey | null {
  const publicKey = readPublicKeyContainer(raw);
  const keyId = readNegotiatedValue(publicKey, raw, 2);
  const keyData = readNegotiatedValue(publicKey, raw, 4);
  if (keyId == null || keyData == null) {
    return null;
  }
  if (!Buffer.isBuffer(keyData) && typeof keyData !== 'string' && !(keyData instanceof Uint8Array)) {
    return null;
  }
  return {
    keyId: String(keyId),
    keyData: Buffer.isBuffer(keyData)
      ? keyData
      : typeof keyData === 'string'
        ? Buffer.from(keyData, 'base64')
        : Buffer.from(keyData),
  };
}
