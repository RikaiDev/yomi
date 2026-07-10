/**
 * CredentialStore — namespace-scoped secure credential storage
 *
 * Vendored from the host app's credential-store module. Stores all
 * credentials for a given namespace as a single JSON blob in one keychain
 * entry (macOS) or one JSON file (other platforms).
 *
 * Yomi owns its LINE credentials: the `login` MCP tool performs a
 * first-party passwordless login and this store persists the resulting
 * session (auth token, certificate, refresh token, mid, E2EE NaCl
 * keypair). The `set`/`save`/`clearAll` methods below are also exercised
 * internally by the vendored LINE session-state code (e.g. persisting a
 * rotated auth token during `resumeSession`), not only by a direct login.
 *
 * Keychain account: namespace (e.g. 'line')
 * KeychainService service name: see keychain.ts — writes go to Yomi's own
 * canonical namespace; a legacy namespace from before this split is read
 * as a fallback and migrated forward, never written to or deleted.
 */

import { getKeychainService } from './keychain.js';

/**
 * Parse a JSON blob into the cache map. Ignores corrupt blobs silently.
 *
 * @param blob - JSON string to parse.
 * @param cache - Map to populate with parsed entries.
 */
function hydrateCacheFromBlob(blob: string, cache: Map<string, any>): void {
  try {
    const obj = JSON.parse(blob);
    for (const [k, v] of Object.entries(obj)) {
      cache.set(k, v);
    }
  }
  catch {
    // Corrupt blob — start fresh, will be overwritten on next write
  }
}

/**
 * Parse a JSON credential blob.
 *
 * @param blob - JSON string to parse.
 * @returns Parsed credential object.
 */
function parseCredentialBlob(blob: string | null): Record<string, any> {
  if (!blob) {
    return {};
  }
  try {
    const parsed = JSON.parse(blob);
    return parsed && typeof parsed === 'object' ? parsed : {};
  }
  catch {
    return {};
  }
}

/** In-memory credential store for testing and non-persistent scenarios. */
export class InMemoryStore {
  public store: Map<string, any>;

  constructor() {
    this.store = new Map();
  }

  /**
   * Gets a credential value.
   * @param key - Credential key.
   * @returns Stored value or null.
   */
  async get(key: string) {
    return this.store.get(key) ?? null;
  }

  /**
   * Sets a credential value.
   * @param key - Credential key.
   * @param value - Value to store.
   */
  async set(key: string, value: any) {
    this.store.set(key, value);
  }

  /**
   * Deletes a credential.
   * @param key - Credential key to delete.
   */
  async delete(key: string) {
    this.store.delete(key);
  }

  /** Wipes all credentials. */
  async clearAll() {
    this.store.clear();
  }
}

/**
 * Stores all credentials for a namespace as a single JSON blob in one keychain
 * entry (macOS) or one JSON file (other platforms).
 *
 * @param namespace - Clean identifier like 'line'.
 * @param fallbackFilePath - File path used on non-macOS platforms.
 */
export class CredentialStore {
  public loaded: boolean;
  public cache: Map<string, any>;
  public filePath: string;
  public keychainService: any;
  public secureStorageEnabled: boolean;
  private readonly keychainAccount: string;
  private lastPersistedBlob: string | null;
  private persistQueue: Promise<void>;

  constructor(namespace: string, fallbackFilePath: string) {
    this.filePath = fallbackFilePath;
    this.cache = new Map();
    this.loaded = false;
    this.secureStorageEnabled = process.platform === 'darwin';
    this.keychainService = this.secureStorageEnabled ? getKeychainService() : null;
    this.keychainAccount = namespace;
    this.lastPersistedBlob = null;
    this.persistQueue = Promise.resolve();
  }

  /**
   * Read the persisted credential blob.
   * @returns Serialized credential blob or null when missing.
   */
  private async readPersistedBlob(): Promise<string | null> {
    if (this.secureStorageEnabled && this.keychainService) {
      const result = await this.keychainService.getCredential(this.keychainAccount);
      if (result.success && result.password) {
        return result.password;
      }
      return null;
    }

    try {
      const fs = await import('node:fs/promises');
      return await fs.readFile(this.filePath, 'utf-8');
    }
    catch {
      return null;
    }
  }

  /**
   * Load all credentials into cache from keychain or file.
   * @param options - Loading behavior.
   * @param options.force - Reload persisted credentials even when cache exists.
   */
  async load(options: { force?: boolean } = {}) {
    if (this.loaded && !options.force) {
      return;
    }

    const blob = await this.readPersistedBlob();
    this.cache.clear();
    if (blob) {
      hydrateCacheFromBlob(blob, this.cache);
      this.lastPersistedBlob = blob;
    }
    else {
      this.lastPersistedBlob = null;
    }
    this.loaded = true;
  }

  /**
   * Persist one serialized credential blob exactly once in write order.
   *
   * @param blob - Serialized credential blob.
   */
  private async persistBlob(blob: string): Promise<void> {
    if (blob === this.lastPersistedBlob) {
      return;
    }

    if (this.secureStorageEnabled && this.keychainService) {
      await this.keychainService.setCredential(this.keychainAccount, blob);
      this.lastPersistedBlob = blob;
      return;
    }

    try {
      const fs = await import('node:fs/promises');
      const dir = this.filePath.substring(0, this.filePath.lastIndexOf('/'));
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.filePath, blob);
      this.lastPersistedBlob = blob;
    }
    catch (error) {
      console.error('[Yomi] Failed to save credentials:', error);
    }
  }

  /**
   * Persist the full cache as a single JSON blob.
   *
   * @param mutatePersisted - Optional mutation applied inside the write queue.
   */
  async save(mutatePersisted?: (persisted: Record<string, any>) => Record<string, any> | void) {
    this.persistQueue = this.persistQueue.then(async () => {
      if (mutatePersisted) {
        const persisted = parseCredentialBlob(await this.readPersistedBlob());
        const next = mutatePersisted(persisted) || persisted;
        const blob = JSON.stringify(next);
        this.cache = new Map(Object.entries(next));
        await this.persistBlob(blob);
        return;
      }

      const blob = JSON.stringify(Object.fromEntries(this.cache));
      await this.persistBlob(blob);
    });
    await this.persistQueue;
  }

  /**
   * Get a credential value by key.
   * @param key - Credential key.
   * @returns Stored value or null.
   */
  async get(key: string) {
    await this.load({ force: true });
    return this.cache.get(key) ?? null;
  }

  /**
   * Set a credential value and persist.
   *
   * `undefined`/`null` are rejected rather than silently dropped: passing
   * either through `JSON.stringify` yields either the literal value
   * `undefined` (which the outer blob `JSON.stringify` then omits with no
   * error) or the string `"null"` masquerading as a real credential. A
   * credential that cannot be stored is a bug at the call site, not a
   * silent no-op — callers must fix the missing value, not have it vanish.
   *
   * @param key - Credential key.
   * @param value - Value to store.
   */
  async set(key: string, value: any) {
    if (value === undefined || value === null) {
      throw new Error(`CredentialStore.set('${key}'): refusing to persist ${value === undefined ? 'undefined' : 'null'} — this would silently drop the key from the stored blob`);
    }
    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
    await this.save((persisted) => {
      persisted[key] = stringValue;
      return persisted;
    });
  }

  /**
   * Delete a credential and persist.
   * @param key - Credential key to delete.
   */
  async delete(key: string) {
    await this.save((persisted) => {
      delete persisted[key];
      return persisted;
    });
  }

  /** Wipe all credentials atomically — one keychain delete covers everything. */
  async clearAll() {
    this.cache.clear();
    this.loaded = false;
    this.lastPersistedBlob = null;

    if (this.secureStorageEnabled && this.keychainService) {
      await this.keychainService.deleteCredential(this.keychainAccount);
      return;
    }

    try {
      const fs = await import('node:fs/promises');
      await fs.unlink(this.filePath);
    }
    catch {
      // File already gone — that's fine
    }
  }
}
