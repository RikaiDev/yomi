/**
 * Persistence helpers for LINE session state.
 * Read/write individual credential fields from the credential store.
 */

import { Buffer } from 'node:buffer'
import { createCliLogger } from '../../../util/log.js'
import { extractE2EEInfo } from '../../auth/protocol/login-metadata.js'

const persistLog = createCliLogger('SESSION-PERSIST')

/**
 * Normalize binary credential values before persistence.
 * @param value - Raw credential value.
 * @returns Persistable string value.
 */
export function toPersistedKeyValue(value: unknown): string | null {
  if (!value) {
    return null
  }
  return Buffer.isBuffer(value) ? value.toString('base64') : String(value)
}

/**
 * Parse an optional numeric credential value.
 * @param value - Raw persisted value.
 * @param fallback - Fallback when the value is missing.
 * @returns Parsed number or fallback.
 */
export function parseStoredNumber(
  value: unknown,
  fallback: number | null,
): number | null {
  return value ? Number(value) : fallback
}

/**
 * Extract persisted token/revision fields from the credential store.
 * @param credentialStore - Persistent LINE credential store.
 * @returns Hydrated session fields.
 */
export async function loadStoredSessionFields(credentialStore: any) {
  const authToken = await credentialStore.get('line_auth_token')
  const refreshToken = await credentialStore.get('line_refresh_token')
  const mid = await credentialStore.get('line_mid')
  const tokenIssueTimeEpochSec = await credentialStore.get(
    'line_token_issue_time_epoch_sec',
  )
  const durationUntilRefreshInSec = await credentialStore.get(
    'line_token_duration_until_refresh_sec',
  )
  const revision = await credentialStore.get('line_revision')
  const globalRevision = await credentialStore.get('line_global_revision')
  const individualRevision = await credentialStore.get(
    'line_individual_revision',
  )

  return {
    authToken,
    refreshToken,
    mid,
    tokenIssueTimeEpochSec,
    durationUntilRefreshInSec,
    revision,
    globalRevision,
    individualRevision,
  }
}

/**
 * Persist LINE auth/session fields provided by a fresh login result.
 *
 * `authToken` is never optional: a login result without it is not a
 * usable session, so it throws instead of writing a half-persisted
 * credential set. The other fields are genuinely optional (a field the
 * LINE login response legitimately omits must not throw), but every
 * call logs exactly which keys were written and which were skipped so
 * an unexpected omission is visible immediately instead of surfacing as
 * "session lost" three hours later.
 *
 * @param credentialStore - Persistent LINE credential store.
 * @param loginResult - Login payload returned by the auth flow.
 */
export async function persistLoginCredentials(
  credentialStore: any,
  loginResult: any,
): Promise<void> {
  if (!loginResult.authToken) {
    throw new Error(
      'persistLoginCredentials: loginResult.authToken is missing — cannot persist a session without an auth token',
    )
  }

  const written: string[] = []
  const skipped: string[] = []

  await credentialStore.set('line_auth_token', loginResult.authToken)
  written.push('line_auth_token')

  if (loginResult.refreshToken) {
    await credentialStore.set('line_refresh_token', loginResult.refreshToken)
    written.push('line_refresh_token')
  } else {
    skipped.push('line_refresh_token')
  }

  if (loginResult.certificate) {
    await credentialStore.set('line_certificate', loginResult.certificate)
    written.push('line_certificate')
  } else {
    skipped.push('line_certificate')
  }

  if (loginResult.mid) {
    await credentialStore.set('line_mid', loginResult.mid)
    written.push('line_mid')
  } else {
    skipped.push('line_mid')
  }

  if (loginResult.tokenIssueTimeEpochSec != null) {
    await credentialStore.set(
      'line_token_issue_time_epoch_sec',
      String(loginResult.tokenIssueTimeEpochSec),
    )
    written.push('line_token_issue_time_epoch_sec')
  } else {
    skipped.push('line_token_issue_time_epoch_sec')
  }

  if (loginResult.durationUntilRefreshInSec != null) {
    await credentialStore.set(
      'line_token_duration_until_refresh_sec',
      String(loginResult.durationUntilRefreshInSec),
    )
    written.push('line_token_duration_until_refresh_sec')
  } else {
    skipped.push('line_token_duration_until_refresh_sec')
  }

  persistLog.info('login-credentials-persisted', {
    written: written.join(','),
    skipped: skipped.join(',') || 'none',
  })
}

/**
 * Persist LINE NaCl/E2EE bootstrap credentials when present.
 *
 * All three fields are optional here (a fresh login may or may not carry
 * new crypto bootstrap material), so a missing field never throws — but
 * every call logs exactly which keys were written and which were skipped.
 *
 * @param credentialStore - Persistent LINE credential store.
 * @param loginResult - Login payload returned by the auth flow.
 */
export async function persistLoginCryptoMaterial(
  credentialStore: any,
  loginResult: any,
): Promise<void> {
  const secretKey = toPersistedKeyValue(loginResult.secretKey)
  const publicKey = toPersistedKeyValue(loginResult.publicKey)
  const written: string[] = []
  const skipped: string[] = []

  if (secretKey) {
    await credentialStore.set('line_nacl_secret_key', secretKey)
    written.push('line_nacl_secret_key')
  } else {
    skipped.push('line_nacl_secret_key')
  }

  if (publicKey) {
    await credentialStore.set('line_nacl_public_key', publicKey)
    written.push('line_nacl_public_key')
  } else {
    skipped.push('line_nacl_public_key')
  }

  if (loginResult.nonce) {
    await credentialStore.set('line_nonce', loginResult.nonce)
    written.push('line_nonce')
  } else {
    skipped.push('line_nonce')
  }

  persistLog.info('login-crypto-material-persisted', {
    written: written.join(',') || 'none',
    skipped: skipped.join(',') || 'none',
  })
}

/**
 * Persist the E2EE bootstrap payload extracted from login metadata.
 *
 * This field is optional (a login result may carry no E2EE bootstrap
 * metadata at all — e.g. a device that already has keys), so a missing
 * field never throws — but every call logs whether the key was written
 * or skipped, and why, so an unexpected omission is visible immediately.
 *
 * @param credentialStore - Persistent LINE credential store.
 * @param loginResult - Login payload returned by the auth flow.
 */
export async function persistLoginBootstrap(
  credentialStore: any,
  loginResult: any,
): Promise<void> {
  const e2eeInfo = extractE2EEInfo(
    loginResult.e2eeInfo || loginResult.metaData || null,
  )
  const secretKey = toPersistedKeyValue(loginResult.secretKey)
  if (
    !e2eeInfo?.encryptedKeyChain ||
    !e2eeInfo?.serverPublicKey ||
    !secretKey
  ) {
    persistLog.info('login-bootstrap-persisted', {
      written: 'none',
      skipped: 'line_e2ee_bootstrap',
      reason: 'no encryptedKeyChain/serverPublicKey/secretKey in login result',
    })
    return
  }

  await credentialStore.set(
    'line_e2ee_bootstrap',
    JSON.stringify({
      encryptedKeyChain: e2eeInfo.encryptedKeyChain.toString('base64'),
      secretKey,
      serverPublicKey: e2eeInfo.serverPublicKey.toString('base64'),
      keyId: e2eeInfo.keyId,
      e2eeVersion: e2eeInfo.e2eeVersion,
    }),
  )
  persistLog.info('login-bootstrap-persisted', {
    written: 'line_e2ee_bootstrap',
    skipped: 'none',
  })
}
