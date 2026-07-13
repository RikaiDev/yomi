/**
 * LINE Passwordless Login — Orchestrator
 *
 * Flow:
 *   1. createSession(phone, region) → sessionId
 *   2. verifyLoginCertificate → skip PIN if cert valid
 *   3. requestPinCodeVerif → PIN displayed to user
 *   4. checkPinCodeVerified → long-poll wait
 *   5. putExchangeKey → NaCl X25519 key exchange
 *   6. requestPaakAuth + checkPaakAuthenticated → biometric
 *   7. loginV2 → authToken + certificate + mid
 */

import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import nacl from 'tweetnacl'
import { sendRequest } from '../../client/transport.js'
import { LINE_APP_CONFIG } from '../../core/config.js'
import { extractE2EEInfo } from '../protocol/login-metadata.js'
import {
  checkPaakAuthenticated,
  checkPinCodeVerified,
  createSession,
  getE2eeKey,
  loginV2,
  PAAK_AUTH_POLL_ATTEMPTS,
  PIN_VERIFY_POLL_ATTEMPTS,
  putExchangeKey,
  requestPaakAuth,
  requestPinCodeVerif,
  verifyLoginCertificate,
} from './steps.js'

/**
 * How long a single long-poll hop is bounded to before LINE's long-poll
 * endpoint returns (or times out). This is NOT the human's window for
 * anything — `checkPinCodeVerified`/`checkPaakAuthenticated` each retry this
 * many times in a loop (see steps.ts), so the real client-side ceiling for
 * each step is this value multiplied by that step's attempt count — see
 * `PIN_VERIFY_CLIENT_CEILING_MS` / `PAAK_AUTH_CLIENT_CEILING_MS` below.
 */
export const PWLESS_POLL_TIMEOUT_MS = 65000

/**
 * Real client-side ceiling for the PIN-verification long-poll loop: how long
 * yomi keeps waiting for the human to enter the PIN before giving up.
 * Derived, not hardcoded — `PWLESS_POLL_TIMEOUT_MS × PIN_VERIFY_POLL_ATTEMPTS`
 * = 65000 × 15 ≈ 16 minutes.
 */
export const PIN_VERIFY_CLIENT_CEILING_MS =
  PWLESS_POLL_TIMEOUT_MS * PIN_VERIFY_POLL_ATTEMPTS

/**
 * Real client-side ceiling for the PAAK (device-approval) long-poll loop: how
 * long yomi keeps waiting for the human to approve the new device before
 * giving up. Derived, not hardcoded —
 * `PWLESS_POLL_TIMEOUT_MS × PAAK_AUTH_POLL_ATTEMPTS` = 65000 × 12 ≈ 13 minutes.
 */
export const PAAK_AUTH_CLIENT_CEILING_MS =
  PWLESS_POLL_TIMEOUT_MS * PAAK_AUTH_POLL_ATTEMPTS

/**
 * LINE's own server-side lifetime for a passwordless login code: the human
 * must enter the code and confirm the device on the primary phone within 3
 * minutes of the code being displayed, or the code is dead — regardless of
 * how long yomi itself is still willing to poll.
 *
 * This is an EXTERNAL FACT, not derived from any of our code or protocol
 * traffic. Source: LINE Help Center (zh-Hant),
 * https://help.line.me/line/IOSSecondary/?contentId=20018574&lang=zh-Hant
 * — on the primary device, tick the device signing in and tap 「用戶確認」
 * within 3 minutes of the code being displayed.
 */
export const LINE_PIN_CODE_LIFETIME_MS = 3 * 60 * 1000

const DEFAULT_CONFIG = {
  ...LINE_APP_CONFIG,
  pollTimeout: PWLESS_POLL_TIMEOUT_MS,
}

/**
 * Handles the LINE passwordless login flow.
 * Emits events: session, pinCreated, waitingForBiometric, loginComplete, error
 */
export class LinePwlessLogin extends EventEmitter {
  public config: any
  public sessionId: string | null
  public secretKey: Buffer | null
  public publicKey: Buffer | null
  public certificate: string | null
  public aborted: boolean
  public seq: number

  constructor(config = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.sessionId = null
    this.secretKey = null
    this.publicKey = null
    this.certificate = null
    this.aborted = false
    this.seq = 1
  }

  /**
   * Abort the login process.
   */
  abort(): void {
    this.aborted = true
    this.emit('abort')
  }

  /**
   * Run the full pwless login flow.
   *
   * @param phone - E.164 phone number
   * @param region - Region code (TW, JP, etc.)
   * @param savedCertificate - Previously saved certificate for skip-PIN
   * @returns Login result with authToken and credentials
   */
  async login(phone: string, region: string, savedCertificate?: string) {
    this.aborted = false
    this.certificate = savedCertificate || null

    // Step 1: Create session
    this.sessionId = await createSession(this as any, phone, region)
    this.emit('session', this.sessionId)

    // Step 2: Check certificate
    const certOk = await verifyLoginCertificate(
      this as any,
      this.certificate || '',
    )

    // Step 3: PIN verification (if cert invalid)
    if (!certOk) {
      const pin = await requestPinCodeVerif(this as any)
      this.emit('pinCreated', pin)

      if (!(await checkPinCodeVerified(this as any))) {
        throw new Error('PIN verification failed or timed out')
      }
      this.emit('pinVerified')
    } else {
      this.emit('certificateVerified')
    }

    // Step 4: E2EE key exchange
    const kp = nacl.box.keyPair()
    this.secretKey = Buffer.from(kp.secretKey)
    this.publicKey = Buffer.from(kp.publicKey)
    await putExchangeKey(this as any, this.publicKey.toString('base64'))

    // Step 5-6: PAAK (biometric) authentication
    await requestPaakAuth(this as any)
    this.emit('waitingForBiometric')

    if (!(await checkPaakAuthenticated(this as any))) {
      console.warn('[LINE] PAAK not confirmed, attempting login anyway')
    } else {
      this.emit('biometricVerified')
    }

    // Step 7: Retrieve E2EE key (required to complete session)
    const e2eeKeyResult = await getE2eeKey(this as any)

    // Step 8: Final login
    const loginResult = await loginV2(this as any, this.config.systemName)

    const result = {
      ...loginResult,
      secretKey: this.secretKey,
      publicKey: this.publicKey,
      e2eeKeyChain: e2eeKeyResult?.encryptedKeyChain ?? null,
      e2eeInfo: extractE2EEInfo(e2eeKeyResult),
      nonce: null,
    }

    this.emit('loginComplete', result)
    return result
  }

  // ─── Transport (used by steps via PwlessContext interface) ─────

  /**
   * Send a pwless request.
   * @param data - TCompact-encoded body
   * @returns Promise resolving to decoded response
   */
  sendPwless(data: Buffer | Uint8Array) {
    return sendRequest(
      this.config.host,
      this.config.pwlessPath,
      data,
      {},
      30000,
      { logger: this.config?.startupFlowLogger || this.config?.logger },
    )
  }

  /**
   * Send a long-poll pwless request.
   * @param data - TCompact-encoded body
   * @returns Promise resolving to decoded response
   */
  sendPwlessLongPoll(data: Buffer | Uint8Array) {
    return sendRequest(
      this.config.host,
      this.config.pwlessLongPollPath,
      data,
      { 'X-Line-Access': this.sessionId, 'x-lst': '60000' },
      this.config.pollTimeout,
      { logger: this.config?.startupFlowLogger || this.config?.logger },
    )
  }
}
