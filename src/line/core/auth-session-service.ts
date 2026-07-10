/**
 * LINE core auth/session capability.
 */

import { performPwlessLogin } from '../auth/protocol/index.js';
import { performLogout } from './auth-session-logout.js';
import { resumeSession as resumeSessionImpl, tryRefreshToken as tryRefreshTokenImpl } from './auth-session-runtime.js';

/**
 * Create the auth/session capability bound to one LINE protocol service.
 *
 * @param service - Mutable LINE protocol service runtime.
 * @param states - Service state constants.
 * @returns Auth/session methods.
 */
export function createAuthSessionService(service: any, states: Record<string, string>) {
  return {
    /**
     * Start the passwordless login process.
     *
     * @param phone - E.164 phone number.
     * @param region - Region code.
     * @returns Promise resolving to the login result.
     */
    async startPwlessLogin(phone: string, region: string): Promise<any> {
      return performPwlessLogin(service, phone, region, states.LOGGING_IN, states.CONNECTED, states.ERROR);
    },

    /**
     * Log out from LINE, clearing the local session regardless of remote result.
     *
     * @returns Promise resolving when logout completes.
     */
    async logout(): Promise<void> {
      return performLogout(service, states.DISCONNECTED);
    },

    /**
     * Mark the active session as invalid after LINE rejects a previously saved token.
     *
     * @param reason - Operator/debug reason for invalidation.
     */
    async invalidateSession(reason = 'line_auth_invalidated'): Promise<void> {
      try {
        service.client?.stopPolling?.();
      }
      catch {
        // Polling may already be stopped.
      }

      const savedPhone = await service.credentialStore?.get?.('line_phone');
      const savedRegion = await service.credentialStore?.get?.('line_region');
      await service.sessionState.clearAuth();
      if (savedPhone) {
        await service.credentialStore?.set?.('line_phone', savedPhone);
      }
      if (savedRegion) {
        await service.credentialStore?.set?.('line_region', savedRegion);
      }

      service.client = null;
      service.profile = null;
      service.e2eeWarning = false;
      service.loginRequired = true;
      service.nameCache.clear();
      service.chatCache.clear();
      service.setState(states.DISCONNECTED);
      service.emit('line:loginRequired', { reason });
      service.emit('error', new Error(reason));
    },

    /**
     * Attempt token refresh via stored refresh token.
     *
     * @returns True when refresh succeeded.
     */
    async tryRefreshToken(): Promise<boolean> {
      return tryRefreshTokenImpl(service);
    },

    /**
     * Restore a previously persisted LINE session.
     *
     * @returns True when the session was restored.
     */
    async resumeSession(): Promise<boolean> {
      return resumeSessionImpl(service);
    },
  };
}
