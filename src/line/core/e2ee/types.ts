/**
 * LINE E2EE types
 */

export interface E2EEConfig {
  keyStore?: unknown
}

export interface KeyPair {
  publicKey: Uint8Array
  privateKey: Uint8Array
}

export interface DecryptResult {
  success: boolean
  message?: string
  error?: string
}
