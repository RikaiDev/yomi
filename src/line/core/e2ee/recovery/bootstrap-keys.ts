import { Buffer } from 'node:buffer';
import { decryptKeyChain } from '../index.js';

/**
 * Attempt to rebuild persisted LINE self keys from the original login bootstrap.
 *
 * When `line_e2ee_keys` is missing but the login-time encrypted keychain and
 * the device secret key are still present in the credential store, we can
 * deterministically reconstruct the same self key material without logging in
 * again. This is strictly a local recovery step: it does not refresh tokens,
 * open new auth sessions, or mutate the remote LINE session.
 *
 * @param service - LineProtocolService-like object
 * @returns Recovered key list, or null when bootstrap material is unavailable
 */
export async function recoverBootstrapKeys(service: any): Promise<any[] | null> {
  const bootstrapInput = await readBootstrapRecoveryInput(service);
  if (!bootstrapInput) {
    return null;
  }

  const keys = rebuildBootstrapKeys(bootstrapInput);
  if (!keys) {
    return null;
  }

  await persistRecoveredKeys(service, keys, bootstrapInput.mid);
  return keys;
}

/**
 * Load and validate the persisted bootstrap inputs required for local E2EE recovery.
 *
 * @param service - LineProtocolService-like object.
 * @returns Decoded bootstrap inputs or null.
 */
async function readBootstrapRecoveryInput(service: any) {
  const bootstrapRaw = await service?.credentialStore?.get?.('line_e2ee_bootstrap');
  const bootstrap = parseBootstrapPayload(bootstrapRaw);
  const secretKeyBase64 = await readPersistedSecretKey(service, bootstrap);
  const decodedBuffers = decodeBootstrapBuffers(bootstrap, secretKeyBase64);
  if (!decodedBuffers) {
    return null;
  }

  return {
    ...decodedBuffers,
    mid: await readPersistedMid(service),
  };
}

/**
 * Read the local device secret used to decrypt LINE's login keychain.
 *
 * @param service - LineProtocolService-like object.
 * @param bootstrap - Parsed bootstrap payload.
 * @returns Base64 secret key or null.
 */
async function readPersistedSecretKey(service: any, bootstrap: any): Promise<string | null> {
  if (bootstrap?.secretKey) {
    return bootstrap.secretKey;
  }
  return await service?.credentialStore?.get?.('line_nacl_secret_key') || null;
}

/**
 * Read the active LINE self MID.
 *
 * @param service - LineProtocolService-like object.
 * @returns Persisted MID or null.
 */
async function readPersistedMid(service: any): Promise<string | null> {
  if (service?.profile?.mid) {
    return service.profile.mid;
  }
  return await service?.credentialStore?.get?.('line_mid') || null;
}

/**
 * Parse the stored bootstrap JSON payload.
 *
 * @param bootstrapRaw - Raw bootstrap JSON.
 * @returns Parsed payload or null.
 */
function parseBootstrapPayload(bootstrapRaw: string) {
  if (!bootstrapRaw) {
    return null;
  }

  try {
    return JSON.parse(bootstrapRaw);
  }
  catch {
    return null;
  }
}

/**
 * Decode the persisted bootstrap buffers needed for key recovery.
 *
 * @param bootstrap - Parsed bootstrap payload.
 * @param secretKeyBase64 - Persisted secret key in base64.
 * @returns Decoded buffers or null.
 */
function decodeBootstrapBuffers(bootstrap: any, secretKeyBase64: string | null) {
  const encryptedKeyChain = decodeBase64Buffer(bootstrap?.encryptedKeyChain);
  const serverPublicKey = decodeBase64Buffer(bootstrap?.serverPublicKey);
  const secretKey = decodeBase64Buffer(secretKeyBase64);
  if (!encryptedKeyChain || !serverPublicKey || !secretKey) {
    return null;
  }

  return {
    encryptedKeyChain,
    serverPublicKey,
    secretKey,
  };
}

/**
 * Rebuild persisted self keys from decoded bootstrap inputs.
 *
 * @param input - Decoded bootstrap inputs.
 * @param input.encryptedKeyChain - Encrypted key chain from login bootstrap.
 * @param input.serverPublicKey - Server public key from login bootstrap.
 * @param input.secretKey - Persisted local secret key.
 * @param input.mid - Optional self MID.
 * @returns Recovered key list or null.
 */
function rebuildBootstrapKeys(input: {
  encryptedKeyChain: Buffer;
  serverPublicKey: Buffer;
  secretKey: Buffer;
  mid: string | null;
}) {
  const keys = decryptKeyChain(input.encryptedKeyChain, input.serverPublicKey, input.secretKey)
    .map((key: any) => ({
      ...key,
      mid: input.mid,
    }));

  return Array.isArray(keys) && keys.length > 0 ? keys : null;
}

/**
 * Persist recovered keys into the in-memory manager and session state.
 *
 * @param service - LineProtocolService-like object.
 * @param keys - Recovered key list.
 * @param mid - Optional self MID.
 */
async function persistRecoveredKeys(service: any, keys: any[], mid: string | null) {
  service.e2eeManager.importKeys(keys);
  if (mid) {
    service.e2eeManager.bindSelfKeysToMid(mid);
  }
  await service.sessionState.saveE2EEKeys(keys);
}

/**
 * Decode a base64-encoded string into a Buffer when possible.
 *
 * @param value - Stored base64 string or Buffer-like value
 * @returns Decoded Buffer or null
 */
function decodeBase64Buffer(value: any): Buffer | null {
  if (!value) {
    return null;
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    return Buffer.from(value, 'base64');
  }
  catch {
    return null;
  }
}
