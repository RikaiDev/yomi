/**
 * LINE Client — TalkService API
 *
 * Core class with transport layer. Domain capabilities are composed
 * from separate modules (DDD bounded contexts):
 *   - auth-service/    — AuthService: refresh, logout, bootstrap flows
 *   - talk-service/    — TalkService read/write capabilities
 *   - sync-service/    — Polling: sync, longPoll, startPolling
 *   - e2ee-service/    — E2EE transport capabilities
 *
 * Endpoints:
 *   /AS4    — AuthService
 *   /S4     — TalkService
 *   /SYNC4  — SyncService
 */

import { EventEmitter } from 'node:events'
import { createCliLogger } from '../../util/log.js'
import { LINE_APP_CONFIG } from '../core/config.js'
import { encodeCallMessage } from '../core/thrift/index.js'
import type { ThriftFieldTuple } from '../core/thrift/types.js'
import { createAuthClient } from './auth-service/client.js'
import { createE2EEClient } from './e2ee-service/client.js'
import { parseOperation } from './parsers.js'
import { createSyncClient } from './sync-service/client.js'
import { createTalkCommandClient } from './talk-service/command-client.js'
import { createTalkQueryClient } from './talk-service/query-client.js'
import { sendRequest } from './transport.js'

const TALK_EXCEPTION_CODE_NAMES: Record<number, string> = {
  5: 'NOT_FOUND',
}
const LINE_AUTH_INVALIDATED_PATTERN =
  /V3_TOKEN_CLIENT_LOGGED_OUT|LOGGED_OUT|DIVESTED/i

/**
 * LINE request error aligned with the shape used by linejs InternalError.
 *
 * @param type - Error type/category
 * @param message - Human-readable diagnostic message
 * @param data - Structured exception payload
 */
export class LineRequestError extends Error {
  public data: Record<string, unknown>
  public type: string

  constructor(
    type: string,
    message: string,
    data: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = type
    this.type = type
    this.data = data
  }
}

/**
 * Detect LINE auth invalidation errors returned after a previously successful login.
 *
 * @param error - Runtime error thrown by LINE TalkService calls.
 * @returns Whether LINE has invalidated the current client token.
 */
export function isLineAuthInvalidatedError(error: unknown): boolean {
  const data = (error as { data?: Record<string, unknown> })?.data
  const exceptionMessage =
    data?.exception && typeof data.exception === 'object'
      ? String((data.exception as Record<string, unknown>)['2'] || '')
      : ''
  const message = error instanceof Error ? error.message : String(error || '')
  return LINE_AUTH_INVALIDATED_PATTERN.test(`${message} ${exceptionMessage}`)
}

/**
 * Resolve the active LINE client logger, preserving startup indentation.
 *
 * @param client - LINE client instance.
 * @returns Logger for transport and request diagnostics.
 */
function getLineClientLog(client: any) {
  if (client?.startupFlowLogger) {
    return client.startupFlowLogger
  }
  if (client?.logger?.info) {
    return client.logger
  }
  return client?.logger || createCliLogger('LINE')
}

/**
 * Normalize one raw TalkException payload into a linejs-like error shape.
 *
 * @param exception - Decoded thrift exception struct from field 1
 * @returns Normalized code/message/rawCode tuple
 */
function normalizeTalkException(exception: Record<number, unknown>) {
  const rawCode = exception?.[1]
  const numericCode =
    typeof rawCode === 'number'
      ? rawCode
      : typeof rawCode === 'bigint'
        ? Number(rawCode)
        : null
  const code =
    numericCode != null
      ? TALK_EXCEPTION_CODE_NAMES[numericCode] || String(numericCode)
      : typeof rawCode === 'string'
        ? rawCode
        : 'UNKNOWN'
  const message =
    typeof exception?.[2] === 'string'
      ? exception[2]
      : JSON.stringify(exception)
  return {
    code,
    message,
    rawCode,
  }
}

/**
 * LINE protocol client. Communicates with LINE servers via TCompact over HTTPS.
 *
 * @param authToken - The LINE authentication token
 * @param config - Configuration options
 */
export class LineClient extends EventEmitter {
  public authToken: any
  public host: any
  public profile: any
  public revision: any
  public globalRevision: any
  public individualRevision: any
  public polling: boolean
  public aborted: boolean
  public seq: number
  public logger: any
  public startupFlowLogger: any
  // The following are mixed in at construction time via Object.assign from
  // the auth/talk/sync/e2ee service factories (see constructor below) — TS
  // cannot see that assignment, so these use definite-assignment assertions.
  public openAuthSession!: (metaData?: Record<string, unknown>) => Promise<any>
  public issueV3TokenForPrimary!: (
    payload: Record<string, unknown>,
  ) => Promise<any>
  public restoreE2EEKeyBackup!: (restoreKey: string) => Promise<any>
  public downloadMessageContent!: (
    messageId: string,
    requestId?: string,
  ) => Promise<Buffer>
  public downloadMessageContentPreview!: (
    messageId: string,
    requestId?: string,
  ) => Promise<Buffer>
  public logoutZ!: () => Promise<any>

  constructor(authToken, config: any = {}) {
    super()
    this.authToken = authToken
    this.host = config.host || LINE_APP_CONFIG.host
    this.revision = config.revision ?? -1
    this.globalRevision = config.globalRevision ?? 0
    this.individualRevision = config.individualRevision ?? 0
    this.polling = false
    this.aborted = false
    this.profile = null
    this.seq = 1
    this.logger = config.logger || createCliLogger('LINE')
    this.startupFlowLogger = config.startupFlowLogger || null

    Object.assign(
      this,
      createAuthClient(this),
      createTalkQueryClient(this),
      createTalkCommandClient(this),
      createSyncClient(this),
      createE2EEClient(this),
    )
  }

  /**
   * Send a TalkService request to the LINE server.
   *
   * @param method - The TalkService method name
   * @param args - The method arguments as Thrift field tuples
   * @returns The decoded server response
   */
  async sendTalk(method: string, args: ThriftFieldTuple[]) {
    const data = encodeCallMessage(method, this.seq++, args)
    const result = await sendRequest(
      this.host,
      LINE_APP_CONFIG.talkPath,
      data,
      { 'X-Line-Access': this.authToken },
      30000,
      { logger: getLineClientLog(this) },
    )
    if (result.nextToken) {
      getLineClientLog(this).info('auth.token_rotated', { method })
      this.authToken = result.nextToken
      this.emit('tokenRotated', result.nextToken)
    }
    if (result.fields?.[1] && typeof result.fields[1] === 'object') {
      const exc = result.fields[1] as Record<number, unknown>
      const normalized = normalizeTalkException(exc)
      throw new LineRequestError(
        'RequestError',
        `Request internal failed, ${method}(${LINE_APP_CONFIG.talkPath}) -> ${normalized.message}`,
        {
          code: normalized.code,
          rawCode: normalized.rawCode,
          method,
          path: LINE_APP_CONFIG.talkPath,
          exception: exc,
        },
      )
    }
    return result
  }

  /**
   * Parse a raw Thrift operation struct into a domain object.
   *
   * @param op - Raw operation data
   * @returns Parsed operation or null
   */
  parseOperation(op: any) {
    return parseOperation(op)
  }
}
