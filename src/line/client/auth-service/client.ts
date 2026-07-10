/**
 * LINE AuthService client capability.
 *
 * Keep auth-service calls separate from TalkService calls so the client mirrors
 * linejs more closely: Talk handles messaging and contacts, Auth handles token
 * lifecycle and credential/bootstrap flows on /AS4, /RS4, and refresh paths.
 */

import type { ThriftFieldTuple } from '../../core/thrift/types.js';
import { Buffer } from 'node:buffer';
import { createCliLogger } from '../../../util/log.js';
import { LINE_APP_CONFIG } from '../../core/config.js';
import { encodeCallMessage } from '../../core/thrift/index.js';
import { sendRequest } from '../transport.js';

/**
 * Resolve the active LINE client logger, preserving startup indentation.
 *
 * @param client - LINE client instance.
 * @returns Logger for auth transport diagnostics.
 */
function getLineClientLog(client) {
  if (client?.startupFlowLogger) {
    return client.startupFlowLogger;
  }
  if (client?.logger?.info) {
    return client.logger;
  }
  return client?.logger || createCliLogger('LINE');
}

/**
 * Normalize LINE auth-service success/error responses.
 *
 * @param method - AuthService method name for diagnostics.
 * @param result - Decoded thrift response.
 * @returns Success payload or boolean true for void methods.
 */
function unwrapAuthSuccess(method, result) {
  if (result.fields?.[1]) {
    const err = result.fields[1];
    throw new Error(`${method} failed: code=${err?.[1]} msg="${err?.[2] || 'Unknown error'}"`);
  }
  return result.fields?.[0] ?? true;
}

/**
 * Create the auth capability bound to one LINE client runtime.
 *
 * @param runtime - Mutable LINE client runtime.
 * @returns Auth service methods bound to the runtime.
 */
export function createAuthClient(runtime) {
  return {
    /**
     * Send a generic AuthService request to LINE.
     *
     * This helper mirrors linejs AuthService.request() behavior for the subset of
     * methods implemented directly here. All callers should pass thrift field
     * tuples that match the upstream struct layout for the target method.
     *
     * @param method - AuthService method name.
     * @param args - TCompact thrift field tuples for the request body.
     * @param path - Override service path when the method is not served from /AS4.
     * @returns Decoded thrift response.
     */
    async sendAuth(method, args: ThriftFieldTuple[] = [], path = LINE_APP_CONFIG.authPath) {
      const data = encodeCallMessage(method, runtime.seq++, args);
      const result = await sendRequest(
        runtime.host,
        path,
        data,
        { 'X-Line-Access': runtime.authToken },
        30000,
        { logger: getLineClientLog(runtime) },
      );
      if (result.nextToken) {
        runtime.authToken = result.nextToken;
        runtime.emit('tokenRotated', result.nextToken);
      }
      if (result.fields?.[1] && typeof result.fields[1] === 'object') {
        const exc = result.fields[1];
        const msg = typeof exc[2] === 'string' ? exc[2] : JSON.stringify(exc);
        console.error(`[LINE] ${method} exception: ${msg}`);
      }
      return result;
    },

    /**
     * Refresh the authentication token through LINE's refresh endpoint.
     *
     * @param refreshToken - The refresh token.
     * @returns Refresh payload with auth token and refresh timing metadata.
     */
    async refreshAuthToken(refreshToken) {
      // stderr-only logger — stdout is the MCP JSON-RPC channel and this runs
      // inside the stdio server (token refresh on resume/rotation).
      const lineLog = getLineClientLog(runtime);
      lineLog.info('auth.refresh.call', {
        auth: `${String(runtime.authToken || '').slice(0, 16)}...`,
        refresh: `${String(refreshToken || '').slice(0, 12)}...`,
      });
      const result = await runtime.sendAuth('refresh', [
        [12, 1, [[11, 1, refreshToken]]],
      ], LINE_APP_CONFIG.tokenRefreshPath);
      const resp = result.fields?.[0];
      if (resp?.[1]) {
        runtime.authToken = resp[1];
        runtime.emit('tokenRotated', resp[1]);
        const durationUntilRefreshInSec = typeof resp[2] === 'bigint' ? Number(resp[2]) : (resp[2] || 0);
        const tokenIssueTimeEpochSec = typeof resp[3] === 'bigint' ? Number(resp[3]) : (resp[3] || null);
        lineLog.info('auth.refresh.success', {
          auth: `${String(resp[1]).slice(0, 16)}...`,
          next_in_hours: Math.round(durationUntilRefreshInSec / 3600),
        });
        return { authToken: resp[1], durationUntilRefreshInSec, tokenIssueTimeEpochSec };
      }
      console.error('[LINE] refresh() exception payload:', JSON.stringify(result, (key, val) => typeof val === 'bigint' ? val.toString() : val));
      throw new Error(`Token refresh failed: ${JSON.stringify(result, (key, val) => typeof val === 'bigint' ? val.toString() : val)}`);
    },

    /**
     * Report a freshly rotated access token back to LINE's auth service.
     *
     * @param authToken - The refreshed access token issued by LINE.
     * @returns Raw decoded auth-service success payload.
     */
    async reportRefreshedAccessToken(authToken) {
      const result = await runtime.sendAuth('reportRefreshedAccessToken', [
        [12, 1, [[11, 1, authToken]]],
      ]);
      return unwrapAuthSuccess('reportRefreshedAccessToken', result);
    },

    /**
     * Open a generic auth session on /AS4.
     *
     * @param metaData - Optional auth session metadata map.
     * @returns Auth session ID string.
     */
    async openAuthSession(metaData = {}) {
      const result = await runtime.sendAuth('openAuthSession', [
        [12, 2, [[13, 1, [11, 11, metaData]]]],
      ]);
      return unwrapAuthSuccess('openAuthSession', result);
    },

    /**
     * Open a legacy auth session using the same metadata-map shape linejs sends.
     *
     * @param metaData - Optional auth session metadata map.
     * @returns Open session response payload.
     */
    async openSession(metaData = {}) {
      const result = await runtime.sendAuth('openSession', [
        [12, 1, [[13, 1, [11, 11, metaData]]]],
      ]);
      return unwrapAuthSuccess('openSession', result);
    },

    /**
     * Fetch the RSA challenge key for identifier/password-style auth flows.
     *
     * @param authSessionId - Session ID returned by openAuthSession/openSession.
     * @param identityProvider - LINE identity-provider enum value.
     * @returns RSA key payload used for upstream credential encryption.
     */
    async getAuthRSAKey(authSessionId, identityProvider) {
      const result = await runtime.sendAuth('getAuthRSAKey', [
        [11, 2, authSessionId],
        [8, 3, identityProvider],
      ]);
      return unwrapAuthSuccess('getAuthRSAKey', result);
    },

    /**
     * Issue a V3 access token for a primary-device style bootstrap flow.
     *
     * @param request - Device identification payload.
     * @returns Access token, refresh token, MID, and refresh timing metadata.
     */
    async issueV3TokenForPrimary(request) {
      const result = await runtime.sendAuth('issueV3TokenForPrimary', [
        [12, 1, [
          [11, 1, request?.udid],
          [11, 2, request?.systemDisplayName],
          [11, 3, request?.modelName],
        ]],
      ]);
      return unwrapAuthSuccess('issueV3TokenForPrimary', result);
    },

    /**
     * Create an enforced E2EE key backup blob on the auth service.
     *
     * @param request - Backup request payload.
     * @returns Backup creation response payload.
     */
    async createE2EEKeyBackupEnforced(request) {
      const result = await runtime.sendAuth('createE2EEKeyBackupEnforced', [
        [12, 2, [
          [11, 1, request?.blobHeader],
          [11, 2, request?.blobPayload],
          [8, 3, request?.reason],
        ]],
      ]);
      return unwrapAuthSuccess('createE2EEKeyBackupEnforced', result);
    },

    /**
     * Restore an E2EE key backup from a server-issued restore claim.
     *
     * @param restoreClaim - Restore claim/token issued by LINE.
     * @returns Restore payload containing the encrypted backup blob.
     */
    async restoreE2EEKeyBackup(restoreClaim) {
      const result = await runtime.sendAuth('restoreE2EEKeyBackup', [
        [12, 2, [[11, 1, restoreClaim]]],
      ]);
      return unwrapAuthSuccess('restoreE2EEKeyBackup', result);
    },

    /**
     * Revoke the current LINE session on the server via logoutZ.
     *
     * @returns Whether the server acknowledged logout success.
     */
    async logoutZ() {
      const payload = Buffer.from([0x82, 0x21, 0x00, 0x07, 0x6C, 0x6F, 0x67, 0x6F, 0x75, 0x74, 0x5A, 0x00]);
      const result = await sendRequest(
        runtime.host,
        LINE_APP_CONFIG.revokePath,
        payload,
        { 'X-Line-Access': runtime.authToken },
        30000,
        { logger: getLineClientLog(runtime) },
      );
      if (result.nextToken) {
        runtime.authToken = result.nextToken;
        runtime.emit('tokenRotated', result.nextToken);
      }
      if (result.fields?.[1]) {
        const err = result.fields[1];
        const code = String(err?.[1] || '');
        const message = String(err?.[2] || '');
        if (code !== 'MUST_REFRESH_V3_TOKEN' && !message.includes('MUST_REFRESH_V3_TOKEN')) {
          throw new Error(`logoutZ failed: code=${code} msg="${message || 'Unknown error'}"`);
        }
      }
      runtime.polling = false;
      runtime.aborted = true;
      return result.fields?.[0] ?? true;
    },
  };
}
