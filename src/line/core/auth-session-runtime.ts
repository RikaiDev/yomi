/**
 * LINE auth/session restore and token refresh runtime.
 */

import { createCliLogger } from '../../util/log.js'
import { recoverBootstrapKeys } from './e2ee/recovery/bootstrap-keys.js'
import { STATE } from './service.js'

const TERMINAL_ERROR_REGEX = /LOGGED_OUT|DIVESTED/i
const AUTH_ERROR_REGEX = /expired|unauthorized|authentication|invalid.*token/i

/**
 * Resolve the active LINE logger for one runtime.
 *
 * @param service - LineProtocolService instance
 * @returns Scope-bound CLI logger
 */
function getLineLog(service: any) {
  if (service?.startupFlowLogger) {
    return service.startupFlowLogger
  }
  if (service?.logger?.info) {
    return service.logger
  }
  return createCliLogger('LINE')
}

/**
 * Restore persisted E2EE self keys or recover them from bootstrap material.
 *
 * @param service - LineProtocolService instance.
 * @param lineLog - Logger instance.
 */
async function restoreE2EEState(service: any, lineLog: any): Promise<void> {
  const savedE2EEKeys = await service.credentialStore.get('line_e2ee_keys')
  if (!savedE2EEKeys) {
    await restoreBootstrapKeys(service, lineLog)
    return
  }

  try {
    const parsedKeys = JSON.parse(savedE2EEKeys)
    if (!Array.isArray(parsedKeys) || parsedKeys.length === 0) {
      return
    }

    service.e2eeManager.importKeys(parsedKeys)
    const savedMid = await service.credentialStore.get('line_mid')
    if (savedMid) {
      service.e2eeManager.bindSelfKeysToMid(savedMid)
    }
    service.e2eeWarning = false
    service.emit('e2eeWarning', { active: false, reason: null })
    lineLog.info('e2ee.restore.complete', { key_count: parsedKeys.length })
  } catch (error: any) {
    lineLog.warn('e2ee.restore.failed', { error: error?.message })
  }
}

/**
 * Attempt E2EE restore from bootstrap material.
 *
 * @param service - LineProtocolService instance.
 * @param lineLog - Logger instance.
 */
async function restoreBootstrapKeys(service: any, lineLog: any): Promise<void> {
  const bootstrapKeys = await recoverBootstrapKeys(service)
  if (bootstrapKeys?.length) {
    service.e2eeWarning = false
    service.emit('e2eeWarning', {
      active: false,
      reason: null,
      recoveredFromBootstrap: true,
    })
    lineLog.info('e2ee.restore.bootstrap_complete', {
      key_count: bootstrapKeys.length,
    })
    return
  }

  service.e2eeWarning = true
  service.emit('e2eeWarning', { active: true, reason: 'missing_keys' })
  lineLog.warn('e2ee.restore.missing_keys', {
    action: 'skip_undecrypted_messages_until_relogin',
  })
}

/**
 * Validate the restored session profile and decide next auth behavior.
 *
 * @param service - LineProtocolService instance.
 * @param lineLog - Logger instance.
 * @returns True when the session is considered restored.
 */
async function validateRestoredSession(
  service: any,
  lineLog: any,
): Promise<boolean> {
  try {
    const profile = await service.client.getProfile()
    if (profile) {
      service.profile = profile
      lineLog.info('session.restore.validated', {
        profile: profile.displayName || profile.mid,
      })
    }
    service.loginRequired = false
    service.setState(STATE.CONNECTED)
    return true
  } catch (validationErr: any) {
    return handleSessionValidationError(service, lineLog, validationErr)
  }
}

/**
 * Handle auth/network errors encountered during restore validation.
 *
 * @param service - LineProtocolService instance.
 * @param lineLog - Logger instance.
 * @param validationErr - Validation error.
 * @returns True when the session remains usable.
 */
async function handleSessionValidationError(
  service: any,
  lineLog: any,
  validationErr: any,
): Promise<boolean> {
  const msg = validationErr?.message || ''
  lineLog.warn('session.restore.validation_failed', { error: msg })
  if (TERMINAL_ERROR_REGEX.test(msg)) {
    // Never destroy credentials on a transient/error-path signal — a
    // regex misfire or one bad response would otherwise cost the operator
    // a phone-PIN re-login for nothing. The stale token stays on disk;
    // a later successful login overwrites it via persistLoginCredentials.
    // clearAuth() remains reserved for the explicit, user-initiated
    // invalidateSession() path (see auth-session-service.ts).
    lineLog.warn('session.restore.revoked', {
      action: 'require_relogin_without_clearing_credentials',
    })
    service.loginRequired = true
    service.setState(STATE.DISCONNECTED)
    service.emit('line:loginRequired')
    return false
  }

  if (AUTH_ERROR_REGEX.test(msg)) {
    lineLog.info('session.restore.refresh_attempt')
    const refreshed = await tryRefreshToken(service)
    if (refreshed) {
      service.loginRequired = false
      service.setState(STATE.CONNECTED)
      return true
    }
    service.loginRequired = true
    service.setState(STATE.DISCONNECTED)
    service.emit('line:loginRequired')
    return false
  }

  lineLog.warn('session.restore.trusted_optimistically')
  service.loginRequired = false
  service.setState(STATE.CONNECTED)
  return true
}

/**
 * Attempt to refresh the LINE auth token using the stored refresh token.
 * Updates credentials in the credential store on success.
 *
 * @param service - LineProtocolService instance
 * @returns True if the token was refreshed successfully, false otherwise.
 */
export async function tryRefreshToken(service: any): Promise<boolean> {
  const lineLog = getLineLog(service)
  try {
    const refreshToken =
      service.sessionState.refreshToken ||
      (await service.credentialStore.get('line_refresh_token'))
    if (!refreshToken || !service.client) {
      lineLog.info('auth.refresh.skip', {
        reason: 'missing_refresh_token_or_client',
      })
      return false
    }
    lineLog.info('auth.refresh.start')
    const result = await service.client.refreshAuthToken(refreshToken)
    await service.sessionState.applyRefreshResult(result)
    try {
      await service.client.reportRefreshedAccessToken?.(result.authToken)
    } catch (reportErr: any) {
      lineLog.warn('auth.refresh.report_failed', { error: reportErr?.message })
    }
    lineLog.info('auth.refresh.complete', {
      next_refresh_hours: Math.round(
        (result.durationUntilRefreshInSec || 0) / 3600,
      ),
    })
    service.emit('tokenRotated', result.authToken)
    return true
  } catch (err: any) {
    lineLog.error('auth.refresh.failed', { error: err?.message })
    return false
  }
}

/**
 * Restore a LINE session from saved credentials.
 * Validates the token with getProfile(), falls back to token refresh on auth error,
 * and emits 'line:loginRequired' if both fail.
 *
 * @param service - LineProtocolService instance
 * @returns True if session was restored successfully, false if re-login is needed.
 */
export async function resumeSession(service: any): Promise<boolean> {
  const lineLog = getLineLog(service)
  try {
    await service.sessionState.loadFromStore()
    service.recentFetchState = await service.sessionState.loadRecentFetchState()
    const token = service.sessionState.authToken
    if (!token) {
      lineLog.info('session.restore.skip', { reason: 'no_saved_auth_token' })
      return false
    }
    lineLog.info('session.restore.start')
    const { LineClient } = await import('../client/index.js')
    service.client = new LineClient(token, {
      logger: service.logger,
      startupFlowLogger: service.startupFlowLogger,
    })
    // `service.client` is its own EventEmitter (see sync-service/client.ts's
    // `runtime.emit('error', ...)` in the poll loop) — a zero-listener 'error'
    // emit there throws uncaught and kills the process just like on `service`
    // itself. Attach here, at construction, for the client's lifetime.
    service.client.on('error', (error: any) =>
      lineLog.warn('client.error', { error: error?.message ?? String(error) }),
    )
    service.sessionState.bindClient(service.client)
    await restoreE2EEState(service, lineLog)
    return validateRestoredSession(service, lineLog)
  } catch (outerErr: any) {
    lineLog.error('session.restore.failed', { error: outerErr?.message })
    return false
  }
}
