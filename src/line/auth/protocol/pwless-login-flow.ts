import { LineClient } from '../../client/index.js';
import { LinePwlessLogin } from '../pwless/index.js';
import { initE2EE } from './e2ee-bootstrap.js';

/**
 * Perform passwordless login and initialize the service client.
 *
 * @param service - The LINE protocol service instance
 * @param phone - E.164 phone number
 * @param region - Region code (TW, JP)
 * @param loggingInState - State to set during login
 * @param connectedState - State to set on successful login
 * @param errorState - State to set on login failure
 * @returns Promise resolving to login result
 */
export async function performPwlessLogin(service, phone, region, loggingInState, connectedState, errorState) {
  // Never write login progress to stdout: under the MCP stdio transport
  // stdout IS the JSON-RPC channel, and this login path runs inside the MCP
  // server. Route through the service logger, which writes to stderr.
  const log = service.startupFlowLogger ?? service.logger;
  service.setState(loggingInState);
  service.pwlessLogin = new LinePwlessLogin(service.config);

  for (const evt of ['pinCreated', 'waitingForBiometric', 'biometricVerified', 'error']) {
    service.pwlessLogin.on(evt, (...args) => service.emit(evt, ...args));
  }

  try {
    const savedCert = await service.credentialStore.get('line_certificate');
    const result = await service.pwlessLogin.login(phone, region, savedCert || undefined);
    log?.info?.('login.ok', { refreshToken: result.refreshToken ? 'yes' : 'no' });
    service.client = new LineClient(result.authToken, {
      ...service.config,
      logger: service.logger,
      startupFlowLogger: service.startupFlowLogger,
    });
    // `service.client` is its own EventEmitter (see sync-service/client.ts's
    // `runtime.emit('error', ...)` in the poll loop) — a zero-listener 'error'
    // emit there throws uncaught and kills the process just like on `service`
    // itself. Attach here, at construction, for the client's lifetime.
    service.client.on('error', (error: any) => {
      const message = error?.message ?? String(error);
      if (service.startupFlowLogger?.warn) {
        service.startupFlowLogger.warn('client.error', { error: message });
      }
      else {
        // stderr, not stdout — stdout is the MCP JSON-RPC channel.
        console.error(`[LINE] client error: ${message}`);
      }
    });
    service.sessionState.bindClient(service.client);
    await service.sessionState.initializeFromLogin(result);
    // Keep login on one auth boundary: one persisted login result,
    // one E2EE bootstrap, one getProfile validation.
    // Any later per-message E2EE failures are runtime content issues, not a reason
    // to mutate auth state, refresh tokens aggressively, or mark the login invalid.
    const e2eeBootstrap = await initE2EE(service, result);
    if (!e2eeBootstrap.success) {
      service.startupFlowLogger?.warn?.('session.login_e2ee_unavailable', {
        reason: e2eeBootstrap.reason,
      });
    }
    service.profile = await service.client.getProfile();
    // Display name only — do not print the mid alongside it.
    log?.info?.('profile.ok', { displayName: service.profile?.displayName ?? null });
    service.loginRequired = false;
    service.setState(connectedState);
    service.emit('loginComplete', { profile: service.profile });
    return result;
  }
  catch (err) {
    service.setState(errorState);
    service.emit('error', err);
    throw err;
  }
}
