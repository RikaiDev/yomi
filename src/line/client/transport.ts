/**
 * Shared HTTP transport for LINE TCompact protocol.
 * Used by both LinePwlessLogin and LineClient.
 */

import { Buffer } from 'node:buffer';
import https from 'node:https';
import { createCliLogger } from '../../util/log.js';
import { LINE_APP_CONFIG } from '../core/config.js';
import { decodeResponseMessage } from '../core/thrift/index.js';

const log = createCliLogger('LINE');

export interface TransportResponse {
  fields?: Record<number, any>;
  error?: string;
  statusCode?: number;
  /** New access token from x-line-next-access header (auto token rotation). */
  nextToken?: string;
}

interface TransportOptions {
  logger?: {
    debug?: (event: string, context?: Record<string, unknown>) => void;
    warn?: (event: string, context?: Record<string, unknown>) => void;
  } | null;
}

/**
 * Resolve the transport logger for the current LINE runtime.
 *
 * @param options - Optional transport options.
 * @returns Logger used for transport diagnostics.
 */
function getTransportLog(options: TransportOptions = {}) {
  return options.logger || log;
}

/**
 * Determine whether one HTTP status is expected during long-poll style LINE auth flows.
 *
 * @param path - Request path.
 * @param statusCode - HTTP status code.
 * @param bodyLength - Response body length.
 * @returns True when the transport event should be downgraded from warning noise.
 */
function isExpectedHttpStatus(path: string, statusCode: number | undefined, bodyLength: number): boolean {
  return statusCode === 410
    && bodyLength === 0
    && (path === LINE_APP_CONFIG.qrLongPollPath || path === LINE_APP_CONFIG.pwlessLongPollPath);
}

/**
 * Send a TCompact request to LINE server.
 *
 * @param host - The LINE server hostname
 * @param path - The API endpoint path
 * @param data - TCompact-encoded body
 * @param extraHeaders - Additional HTTP headers
 * @param timeout - Request timeout in milliseconds
 * @param options - Optional transport logging options
 * @returns Promise resolving to decoded response with optional nextToken
 */
export function sendRequest(
  host: string,
  path: string,
  data: Buffer | Uint8Array,
  extraHeaders: Record<string, unknown> = {},
  timeout = 30000,
  options: TransportOptions = {},
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const transportLog = getTransportLog(options);
    const headers = {
      'Content-Type': 'application/x-thrift',
      'Accept': 'application/x-thrift',
      'X-Line-Application': LINE_APP_CONFIG.lineApp,
      'User-Agent': LINE_APP_CONFIG.userAgent,
      'x-lal': 'ja_JP',
      'x-lpv': '1',
      ...extraHeaders,
      'Content-Length': data.length,
    };

    const req = https.request({
      hostname: host,
      port: 443,
      path,
      method: 'POST',
      headers,
      timeout,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        const nextToken = extractNextToken(res.headers);
        if (nextToken) {
          transportLog.debug?.('transport.token_rotated', { path });
        }
        if (res.statusCode && res.statusCode >= 400) {
          const eventName = isExpectedHttpStatus(path, res.statusCode, body.length)
            ? 'transport.http_expected'
            : 'transport.http_error';
          const logMethod = isExpectedHttpStatus(path, res.statusCode, body.length)
            ? transportLog.debug
            : transportLog.warn;
          logMethod?.(eventName, { path, status: res.statusCode, bytes: body.length });
        }
        if (body.length > 0) {
          try {
            const decoded = decodeResponseMessage(body);
            resolve({ ...decoded, statusCode: res.statusCode, nextToken });
          }
          catch (error: any) {
            console.error(`[LINE] Decode failed on ${path}: ${error?.message || error} [${body.length}B]`);
            console.error(`[LINE] Decode first 64B on ${path}: ${body.subarray(0, 64).toString('hex')}`);
            console.error(`[LINE] Decode last 64B on ${path}: ${body.subarray(Math.max(0, body.length - 64)).toString('hex')}`);
            reject(error);
          }
        }
        else {
          resolve({ error: 'empty_response', statusCode: res.statusCode, nextToken });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });

    req.on('error', (err) => {
      const errorCode = (err as NodeJS.ErrnoException).code;
      if (
        errorCode === 'ECONNRESET'
        || errorCode === 'ETIMEDOUT'
        || err.message.includes('socket hang up')
        || err.message.includes('ETIMEDOUT')
      ) {
        resolve({ error: 'timeout' });
      }
      else {
        reject(err);
      }
    });

    req.write(data);
    req.end();
  });
}

/**
 * Extract new access token from LINE response headers.
 * LINE rotates tokens by sending x-line-next-access in any response.
 *
 * @param headers - HTTP response headers
 * @returns New token string or undefined
 */
function extractNextToken(headers: Record<string, any>): string | undefined {
  const next = headers['x-line-next-access'];
  return typeof next === 'string' && next.length > 0 ? next : undefined;
}
