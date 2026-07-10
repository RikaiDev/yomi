import { Buffer } from 'node:buffer';

/**
 * Decode a base64-encoded value into a Buffer when present.
 *
 * @param value - Buffer or base64 string from a login response.
 * @returns Decoded Buffer or null.
 */
function decodeMaybeBase64(value: any): Buffer | null {
  if (!value) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value === 'string') {
    return Buffer.from(value, 'base64');
  }
  return null;
}

/**
 * Convert a mixed login metadata value into a number when possible.
 *
 * @param value - Raw numeric value or numeric string.
 * @returns Parsed number or null.
 */
function toMaybeNumber(value: any): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Resolve the metadata payload from a raw login response.
 *
 * @param raw - Raw login response or nested E2EE payload.
 * @returns Metadata object or null.
 */
function resolveE2EEMetadata(raw: any): any {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const nested = raw.metadata || raw.metaData || raw[10]?.metadata || raw[10]?.metaData;
  if (nested && typeof nested === 'object') {
    return nested;
  }

  return raw;
}

/**
 * Check whether a metadata object has the minimum E2EE bootstrap fields.
 *
 * @param metadata - Metadata candidate.
 * @returns Whether the candidate carries keychain and public key.
 */
function hasE2EEBootstrapFields(metadata: any): boolean {
  return Boolean(
    metadata
    && typeof metadata === 'object'
    && (metadata.encryptedKeyChain || metadata[6] || metadata[3])
    && (metadata.serverPublicKey || metadata.publicKey || metadata[4]),
  );
}

/**
 * Search child object values for a nested E2EE payload.
 *
 * @param metadata - Metadata object.
 * @param depth - Remaining search depth.
 * @returns Payload-like object or null.
 */
function findNestedE2EEMetadata(metadata: Record<string, unknown>, depth: number): any {
  for (const child of Object.values(metadata)) {
    if (child && typeof child === 'object') {
      const found = findE2EEMetadata(child, depth - 1);
      if (found && hasE2EEBootstrapFields(found)) {
        return found;
      }
    }
  }
  return null;
}

/**
 * Recursively find a nested E2EE payload.
 *
 * @param value - Candidate payload.
 * @param depth - Remaining search depth.
 * @returns Payload-like object or null.
 */
function findE2EEMetadata(value: any, depth = 3): any {
  const metadata = resolveE2EEMetadata(value);
  if (!metadata || typeof metadata !== 'object' || depth < 0) {
    return null;
  }
  if (hasE2EEBootstrapFields(metadata)) {
    return metadata;
  }
  return findNestedE2EEMetadata(metadata, depth) || metadata;
}

/**
 * Resolve the encrypted keychain field from known LINE metadata shapes.
 *
 * @param metadata - E2EE metadata payload.
 * @returns Encrypted keychain value.
 */
function getEncryptedKeyChainField(metadata: any): any {
  return metadata.encryptedKeyChain || metadata[6] || metadata[3] || null;
}

/**
 * Resolve the server public key field from known LINE metadata shapes.
 *
 * @param metadata - E2EE metadata payload.
 * @returns Server public key value.
 */
function getServerPublicKeyField(metadata: any): any {
  return metadata.serverPublicKey || metadata.publicKey || metadata[4] || null;
}

/**
 * Resolve the E2EE key id field from known LINE metadata shapes.
 *
 * @param metadata - E2EE metadata payload.
 * @returns Key id value.
 */
function getKeyIdField(metadata: any): any {
  return metadata.keyId || metadata.e2EEPublicKeyId || metadata[2] || null;
}

/**
 * Resolve the E2EE version field from known LINE metadata shapes.
 *
 * @param metadata - E2EE metadata payload.
 * @returns Version value.
 */
function getE2EEVersionField(metadata: any): any {
  return metadata.e2eeVersion || metadata.version || metadata[1] || null;
}

/**
 * Normalize LINE login E2EE metadata into a common structure.
 *
 * @param raw - Raw E2EE metadata struct from LINE login APIs.
 * @returns Normalized encrypted keychain payload or null when incomplete.
 */
export function extractE2EEInfo(raw: any): {
  encryptedKeyChain: Buffer | null;
  serverPublicKey: Buffer | null;
  keyId: number | null;
  e2eeVersion: number | null;
} | null {
  const metadata = findE2EEMetadata(raw);
  if (!metadata) {
    return null;
  }

  const encryptedKeyChain = decodeMaybeBase64(getEncryptedKeyChainField(metadata));
  const serverPublicKey = decodeMaybeBase64(getServerPublicKeyField(metadata));
  const keyId = toMaybeNumber(getKeyIdField(metadata));
  const e2eeVersion = toMaybeNumber(getE2EEVersionField(metadata));

  if (!encryptedKeyChain || !serverPublicKey) {
    return null;
  }

  return {
    encryptedKeyChain,
    serverPublicKey,
    keyId,
    e2eeVersion,
  };
}
