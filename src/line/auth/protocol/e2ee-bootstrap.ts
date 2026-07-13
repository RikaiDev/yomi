import { decryptKeyChain } from '../../core/e2ee/index.js'

interface E2EEBootstrapResult {
  keyCount: number
  reason: string | null
  success: boolean
}

/**
 * Resolve the active LINE logger.
 *
 * @param service - LINE protocol service instance.
 * @returns Logger-like object.
 */
function getLineLog(service: any) {
  return service?.startupFlowLogger || service?.logger || console
}

/**
 * Build a missing-bootstrap result and emit the matching warning.
 *
 * @param service - LINE protocol service instance.
 * @param loginResult - Login result.
 * @param e2eeInfo - Normalized E2EE info.
 * @returns Failed bootstrap result.
 */
function buildMissingBootstrapResult(
  service: any,
  loginResult: any,
  e2eeInfo: any,
): E2EEBootstrapResult {
  const reason = 'missing_login_e2ee_bootstrap'
  getLineLog(service).warn?.('e2ee.init.skipped', {
    has_keychain: Boolean(e2eeInfo?.encryptedKeyChain),
    has_secret_key: Boolean(loginResult.secretKey),
    has_server_public_key: Boolean(e2eeInfo?.serverPublicKey),
    reason,
  })
  service.e2eeWarning = true
  service.emit?.('e2eeWarning', { active: true, reason })
  return { keyCount: 0, reason, success: false }
}

/**
 * Import decoded self keys into the active service.
 *
 * @param service - LINE protocol service instance.
 * @param loginResult - Login result.
 * @param keys - Decoded self keys.
 */
async function applyDecodedKeys(
  service: any,
  loginResult: any,
  keys: any[],
): Promise<void> {
  service.e2eeManager.importKeys(keys)
  if (loginResult.mid) {
    service.e2eeManager.bindSelfKeysToMid(loginResult.mid)
  }
  await service.sessionState.saveE2EEKeys(keys)
  service.e2eeWarning = false
  service.emit?.('e2eeWarning', { active: false, reason: null })
}

/**
 * Initializes end-to-end encryption with login credentials.
 *
 * @param service - The LINE protocol service instance
 * @param loginResult - The login result containing encryption keys
 * @returns E2EE bootstrap result
 */
export async function initE2EE(
  service,
  loginResult,
): Promise<E2EEBootstrapResult> {
  const lineLog = getLineLog(service)
  const e2eeInfo = loginResult.e2eeInfo || null
  if (
    !e2eeInfo?.encryptedKeyChain ||
    !e2eeInfo?.serverPublicKey ||
    !loginResult.secretKey
  ) {
    return buildMissingBootstrapResult(service, loginResult, e2eeInfo)
  }
  try {
    // This step only imports self keys delivered during login. It is allowed to fail
    // without invalidating the just-issued auth token. Message decryption during scan
    // and polling uses additional peer/group material and can still fail later even
    // when this bootstrap succeeds, so callers must treat E2EE bootstrap and login
    // validation as separate failure domains.
    const keys = decryptKeyChain(
      e2eeInfo.encryptedKeyChain,
      e2eeInfo.serverPublicKey,
      loginResult.secretKey,
    ).map((key: any) => ({
      ...key,
      mid: loginResult.mid || null,
    }))
    await applyDecodedKeys(service, loginResult, keys)
    lineLog.info?.('e2ee.init.complete', {
      key_count: keys.length,
      key_id: e2eeInfo.keyId ?? null,
      version: e2eeInfo.e2eeVersion ?? null,
    })
    return { keyCount: keys.length, reason: null, success: keys.length > 0 }
  } catch (e: any) {
    const reason = 'keychain_decrypt_failed'
    lineLog.warn?.('e2ee.init.failed', { error: e?.message, reason })
    service.e2eeWarning = true
    service.emit?.('e2eeWarning', { active: true, reason })
    return { keyCount: 0, reason, success: false }
  }
}
