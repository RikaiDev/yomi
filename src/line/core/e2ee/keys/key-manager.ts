import type {
  EncryptedMessagePayload,
  GroupKey,
  GroupKeyFetchState,
  ImportedKey,
  KeyManagerContext,
  KeyPair,
} from './key-types.js';
import { Buffer } from 'node:buffer';
import { generateKeyPairSync } from 'node:crypto';
import { createCliLogger } from '../../../../util/log.js';

import { tryDecrypt as tryDecryptFn } from './decrypt.js';
import { encryptE2EEMessage as encryptE2EEMessageFn } from './encrypt.js';
import { toChunkKeyId } from './message-crypto.js';

const e2eeLog = createCliLogger('E2EE');

/**
 * KeyManager handles E2EE key generation and storage.
 * Implements {@link KeyManagerContext} so it can be passed as `ctx` to module-level functions.
 */
export class KeyManager implements KeyManagerContext {
  private keys: Map<string, KeyPair> = new Map();
  private importedKeys: Map<string, ImportedKey> = new Map();
  private selfKeyByMid: Map<string, ImportedKey> = new Map();
  peerPublicKeys: Map<string, Buffer> = new Map();
  groupKeys: Map<string, GroupKey> = new Map();
  groupKeyFetches: Map<string, GroupKeyFetchState> = new Map();
  private runtimeGetClient?: () => any;
  private runtimeGetStore?: () => any;
  private runtimeGetProfileMid?: () => string | undefined;
  private emitWarning?: (payload: { active: boolean; reason: string; [key: string]: any }) => void;

  /**
   * Generate a new X25519 key pair for E2EE.
   * @returns Generated key pair
   */
  generateKeyPair(): KeyPair {
    const keyPair = generateKeyPairSync('x25519');
    return {
      publicKey: keyPair.publicKey.export({ type: 'spki', format: 'der' }).slice(-32) as unknown as Uint8Array,
      privateKey: keyPair.privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32) as unknown as Uint8Array,
    };
  }

  /**
   * Store a key pair for a user.
   * @param userId - User identifier
   * @param keyPair - Key pair to store
   */
  storeKey(userId: string, keyPair: KeyPair): void {
    this.keys.set(userId, keyPair);
  }

  /**
   * Get a user's stored key pair.
   * @param userId - User identifier.
   * @returns Stored key pair when present.
   */
  getKey(userId: string): KeyPair | undefined {
    return this.keys.get(userId);
  }

  /**
   * Check if a user has a stored key.
   * @param userId - User identifier.
   * @returns True when a key exists for the user.
   */
  hasKey(userId: string): boolean {
    return this.keys.has(userId);
  }

  /**
   * Import E2EE keys decoded from the login keychain.
   * Called after successful login with the decrypted key list.
   * @param keys - Array of key objects from decryptKeyChain
   */
  importKeys(keys: any[]): void {
    for (const k of keys) {
      const keyId = String(k.keyId);
      const importedKey: ImportedKey = {
        keyId,
        version: k.version != null ? String(k.version) : undefined,
        createdTime: k.createdTime != null ? Number(k.createdTime) : null,
        publicKey: Buffer.isBuffer(k.publicKey) ? k.publicKey : Buffer.from(k.publicKey),
        privateKey: Buffer.isBuffer(k.privateKey) ? k.privateKey : Buffer.from(k.privateKey),
      };
      this.importedKeys.set(keyId, importedKey);
      if (k.mid) {
        this.selfKeyByMid.set(String(k.mid), importedKey);
      }
    }
    this.resolveLogger().info('e2ee.keys.imported', {
      count: keys.length,
    });
  }

  /**
   * Associate an imported self key with the authenticated user's MID.
   * @param mid - Authenticated LINE MID
   */
  bindSelfKeysToMid(mid: string): void {
    const latest = [...this.importedKeys.values()]
      .sort((a, b) => (b.createdTime ?? 0) - (a.createdTime ?? 0))[0];
    if (latest) {
      this.selfKeyByMid.set(mid, latest);
    }
  }

  /**
   * Return a self key by stored key ID.
   * @param keyId - Imported self key identifier.
   * @returns Matching imported key when present.
   */
  getSelfKeyById(keyId: string): ImportedKey | undefined {
    return this.importedKeys.get(String(keyId));
  }

  /**
   * Return the authenticated user's current self key by MID.
   * @param mid - Authenticated LINE MID.
   * @returns Matching imported key when present.
   */
  getSelfKeyByMid(mid: string): ImportedKey | undefined {
    return this.selfKeyByMid.get(String(mid));
  }

  /**
   * Clear only runtime-discovered E2EE caches while preserving imported self keys.
   *
   * This is used by session-level recovery: peer public keys and group shared
   * keys may have become stale or incomplete, but the authenticated self key
   * material should survive across retries until the user explicitly logs out.
   */
  resetTransientCaches(): void {
    this.peerPublicKeys.clear();
    this.groupKeys.clear();
    this.groupKeyFetches.clear();
  }

  /**
   * Bind runtime dependencies required for async E2EE key resolution.
   * @param deps - Runtime dependency providers.
   * @param deps.getClient - Returns the active LINE client.
   * @param deps.getStore - Returns the credential store.
   * @param deps.getProfileMid - Returns the authenticated profile MID.
   * @param deps.emitWarning - Emits a recovery warning to the service.
   */
  setRuntime(deps: {
    getClient: () => any;
    getStore: () => any;
    getProfileMid: () => string | undefined;
    emitWarning?: (payload: { active: boolean; reason: string; [key: string]: any }) => void;
  }): void {
    this.runtimeGetClient = deps.getClient;
    this.runtimeGetStore = deps.getStore;
    this.runtimeGetProfileMid = deps.getProfileMid;
    this.emitWarning = deps.emitWarning;
  }

  /**
   * Return the active LINE client when runtime dependencies are bound.
   * @returns Active LINE client.
   */
  getClient(): any { return this.runtimeGetClient?.(); }

  /**
   * Return the credential store when runtime dependencies are bound.
   * @returns Credential store.
   */
  getStore(): any { return this.runtimeGetStore?.(); }

  /**
   * Return the authenticated LINE MID when runtime dependencies are bound.
   * @returns Authenticated LINE MID.
   */
  getProfileMid(): string | undefined { return this.runtimeGetProfileMid?.(); }

  /**
   * Emit a recovery warning if the service is available.
   * @param reason - Warning reason code.
   * @param details - Additional warning metadata.
   */
  raiseWarning(reason: string, details: Record<string, any> = {}): void {
    this.emitWarning?.({ active: true, reason, ...details });
  }

  /**
   * Emit one visible LINE runtime log for group-key diagnostics.
   * @param event - Event name
   * @param context - Structured payload
   */
  logGroupKeyEvent(event: string, context: Record<string, any> = {}): void {
    this.resolveLogger().info(event, context);
  }

  /**
   * Emit one warning-level E2EE log through the shared CLI logger.
   *
   * @param event - Event name
   * @param context - Structured payload
   */
  logE2EEWarning(event: string, context: Record<string, any> = {}): void {
    this.resolveLogger().warn(event, context);
  }

  /**
   * Resolve the active E2EE logger using the shared logging contract.
   *
   * @returns Startup-aware CLI logger.
   */
  private resolveLogger() {
    const client = this.getClient();
    return client?.startupFlowLogger || client?.logger || e2eeLog;
  }

  /**
   * Attempt to decrypt an E2EE message using stored keys.
   * Returns plaintext on success, or a no-op result for plaintext messages.
   * @param msg - Parsed message object (from parsers.ts)
   * @returns Decryption result with optional plaintext
   */
  async tryDecrypt(msg: any): Promise<{ decrypted: boolean; text?: string }> {
    return tryDecryptFn(this, msg);
  }

  /**
   * Prepare an outbound LINE E2EE payload using the same chunk layout as linejs.
   *
   * The returned structure is transport-ready for TalkService sendMessage:
   * `chunks` contains `[salt, ciphertext+tag, nonce, senderKeyIdBytes, receiverKeyIdBytes]`
   * and `contentMetadata` includes the E2EE markers LINE expects for version 2.
   *
   * @param to - Target LINE MID
   * @param data - Text or structured payload to encrypt
   * @param contentType - LINE content type of the payload
   * @returns Message chunks plus metadata required by LINE
   */
  async encryptE2EEMessage(to: string, data: string | Record<string, any>, contentType = 0): Promise<EncryptedMessagePayload> {
    return encryptE2EEMessageFn(this, to, data, contentType);
  }

  /**
   * Public wrapper used by logging/initializer layers to format key IDs from
   * raw message chunks without duplicating chunk parsing logic outside E2EE.
   *
   * @param value - Raw LINE chunk value
   * @returns Parsed decimal key ID or null
   */
  readChunkKeyId(value: any): string | null {
    return toChunkKeyId(value);
  }
}
