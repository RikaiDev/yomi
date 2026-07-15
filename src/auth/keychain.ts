/**
 * macOS Keychain backing store for Yomi credentials.
 *
 * Vendored from the host app's system/auth keychain service. Used by
 * CredentialStore when running on darwin; other platforms fall back to a
 * plain JSON file (see credential-store.ts).
 */

import { spawn } from 'node:child_process'
import { createCliLogger } from '../util/log.js'

/**
 * Yomi's own Keychain service name. Yomi performs a first-party
 * passwordless LINE login (see the `login` MCP tool) and persists the
 * resulting session here — auth token, certificate, refresh token, mid,
 * and the E2EE NaCl keypair. All writes go through this namespace only.
 */
const SERVICE_NAME = 'com.yomi.credentials'

/**
 * Legacy keychain service name, read-only. Predates Yomi owning its own
 * credentials; kept solely so a live session created before this split
 * keeps working without forcing the operator through a phone-PIN
 * re-login. Entries here are read and migrated forward into
 * `SERVICE_NAME`, never written to and never deleted.
 */
const LEGACY_SERVICE_NAME = 'com.inboxd.credentials'
const authLog = createCliLogger('AUTH')

export interface CredentialResult {
  success: boolean
  account?: string
  password?: string
  error?: string
}

/**
 * Wrapper for macOS `security` keychain CLI commands.
 */
class KeychainCommands {
  constructor(private serviceName: string) {}

  /**
   * Store a credential in Keychain.
   *
   * @param account - Account name.
   * @param password - Password to store.
   * @returns Promise resolving to credential result.
   */
  async set(account: string, password: string): Promise<CredentialResult> {
    return new Promise((resolve) => {
      const child = spawn('security', [
        'add-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
        '-w',
        password,
        '-U',
      ])

      let stderr = ''
      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          authLog.debug('keychain.store.complete', { account })
          resolve({ success: true, account })
        } else {
          authLog.error('keychain.store.failed', {
            account,
            error: stderr || 'Failed to store credential',
          })
          resolve({
            success: false,
            error: stderr || 'Failed to store credential',
          })
        }
      })

      child.on('error', (err) => {
        authLog.error('keychain.store.error', { account, error: err.message })
        resolve({ success: false, error: err.message })
      })
    })
  }

  /**
   * Retrieve a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async get(account: string): Promise<CredentialResult> {
    return new Promise((resolve) => {
      const child = spawn('security', [
        'find-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
        '-w',
      ])

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0 && stdout.trim()) {
          resolve({
            success: true,
            account,
            password: stdout.trim(),
          })
        } else {
          resolve({
            success: false,
            account,
            error: stderr.includes('could not be found')
              ? 'Credential not found'
              : stderr || 'Failed to retrieve credential',
          })
        }
      })

      child.on('error', (err) => {
        resolve({ success: false, account, error: err.message })
      })
    })
  }

  /**
   * Delete a credential from Keychain.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async delete(account: string): Promise<CredentialResult> {
    return new Promise((resolve) => {
      const child = spawn('security', [
        'delete-generic-password',
        '-s',
        this.serviceName,
        '-a',
        account,
      ])

      let stderr = ''
      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          authLog.debug('keychain.delete.complete', { account })
          resolve({ success: true, account })
        } else {
          resolve({
            success: false,
            account,
            error: stderr.includes('could not be found')
              ? 'Credential not found'
              : stderr || 'Failed to delete credential',
          })
        }
      })

      child.on('error', (err) => {
        resolve({ success: false, account, error: err.message })
      })
    })
  }
}

/**
 * Service for managing macOS Keychain credentials.
 *
 * Reads try the canonical namespace first, then fall back to the legacy
 * namespace and migrate a hit forward. Writes and deletes only ever touch
 * the canonical namespace — the legacy entry is never deleted.
 */
export class KeychainService {
  private commands: KeychainCommands
  private legacyCommands: KeychainCommands
  // Accounts whose canonical entry this process has already seen (read or
  // written). Once seen, a later read miss is treated as transient and must
  // NOT fall back to the legacy namespace — see getCredential.
  private canonicalSeen = new Set<string>()

  constructor() {
    this.commands = new KeychainCommands(SERVICE_NAME)
    this.legacyCommands = new KeychainCommands(LEGACY_SERVICE_NAME)
  }

  /**
   * Stores a credential in Keychain.
   *
   * @param account - Account name.
   * @param password - Password to store.
   * @returns Promise resolving to credential result.
   */
  async setCredential(
    account: string,
    password: string,
  ): Promise<CredentialResult> {
    // `add-generic-password -U` updates the item in place when it exists, so
    // this is a single atomic keychain op. Do NOT delete-then-add: that leaves
    // a window where the entry is absent, during which a concurrent read falls
    // through to the legacy namespace and resurrects stale credentials over the
    // current ones (the root of the "session silently logged out" bug).
    const result = await this.commands.set(account, password)
    if (result.success) {
      this.canonicalSeen.add(account)
    }
    return result
  }

  /**
   * Retrieves a credential from Keychain.
   *
   * Tries the canonical namespace first. Only if this process has NEVER seen
   * the canonical entry does it fall back to the legacy namespace and migrate a
   * hit forward (one-time). Once the canonical entry has been seen, a later
   * miss is transient (item mid-update) and returns the miss as-is rather than
   * resurrecting a stale legacy copy on top of the live session.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async getCredential(account: string): Promise<CredentialResult> {
    const primary = await this.commands.get(account)
    if (primary.success) {
      this.canonicalSeen.add(account)
      return primary
    }
    if (this.canonicalSeen.has(account)) {
      return primary
    }

    const legacy = await this.legacyCommands.get(account)
    if (legacy.success && legacy.password) {
      await this.commands.set(account, legacy.password)
      this.canonicalSeen.add(account)
      authLog.info('keychain.migrated_from_legacy', { account })
    }
    return legacy
  }

  /**
   * Deletes a credential from Keychain.
   *
   * Operates on the canonical namespace only. The legacy namespace is
   * never deleted, even here.
   *
   * @param account - Account name.
   * @returns Promise resolving to credential result.
   */
  async deleteCredential(account: string): Promise<CredentialResult> {
    return await this.commands.delete(account)
  }
}

let keychainServiceInstance: KeychainService | null = null

/**
 * Gets the singleton keychain service instance.
 *
 * @returns The KeychainService instance.
 */
export function getKeychainService(): KeychainService {
  if (!keychainServiceInstance) {
    keychainServiceInstance = new KeychainService()
  }
  return keychainServiceInstance
}
