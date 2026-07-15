/**
 * LINE Protocol Service - Yomi's read-only session/query core.
 *
 * Orchestrates session resume (with auto token refresh) and E2EE
 * decryption. Login and continuous polling live in the vendored auth
 * modules but are never invoked by Yomi's MCP server — see README.md.
 */

import { EventEmitter } from 'node:events'
import { CredentialStore } from '../../auth/credential-store.js'
import { createCliLogger } from '../../util/log.js'
import { createAuthSessionService } from './auth-session-service.js'
import { createChatRuntimeService } from './chat-runtime-service.js'
import { createDirectoryRuntimeService } from './directory-runtime-service.js'
import { E2EEKeyManager } from './e2ee/index.js'
import { LineSessionState } from './session-state/index.js'

/** Valid states for the LINE Protocol Service. */
export const STATE = {
  DISCONNECTED: 'disconnected',
  LOGGING_IN: 'logging_in',
  CONNECTED: 'connected',
  POLLING: 'polling',
  ERROR: 'error',
} as const

/**
 * High-level LINE service coordinating all aspects of the protocol.
 * Used by Adapter and Agent layers.
 */
export class LineProtocolService extends EventEmitter {
  public options: any
  public state: string
  public client: any
  public profile: any
  public startupFlowLogger: any
  public logger: any
  public credentialStore: any
  public sessionState: any
  public nameCache: Map<string, string>
  public chatCache: Map<string, any>
  public e2eeManager: any
  public e2eeWarning: boolean
  public loginRequired: boolean
  public recentFetchState: Map<
    string,
    {
      lastCheckedAt: number
      lastDeliveredMessageId: string | null
      lastDeliveredTime: number
    }
  >

  // The following are mixed in at construction time via Object.assign from
  // createAuthSessionService / createDirectoryRuntimeService /
  // createChatRuntimeService (see constructor below) — TS cannot see that
  // assignment, so these use definite-assignment assertions. Yomi's MCP
  // server calls resumeSession/sendMessage/getRecentMessages/
  // getPreviousMessages/download* only; it never calls startPwlessLogin
  // (still present for compile completeness).
  public startPwlessLogin!: (phone: string, region: string) => Promise<any>
  public logout!: () => Promise<void>
  public invalidateSession!: (reason?: string) => Promise<void>
  public tryRefreshToken!: () => Promise<boolean>
  public resumeSession!: () => Promise<boolean>
  public resolveName!: (mid: string) => string
  public getContact!: (mid: string) => Promise<any>
  public getGroup!: (groupId: string) => Promise<any>
  public listStickerPackages!: (language?: string) => Promise<any[]>
  public searchStickerPackages!: (
    query: string,
    language?: string,
    limit?: number,
  ) => Promise<{ total: number; packages: any[] }>
  public sendMessage!: (
    to: string,
    text: string,
    contentMetadata?: Record<string, string>,
    reply?: {
      relatedMessageId: string
      messageRelationType: number
      relatedMessageServiceCode?: number
    },
  ) => Promise<any>
  public sendImage!: (
    to: string,
    imageBytes: Buffer,
    fileName: string | null,
  ) => Promise<any>
  public sendFile!: (
    to: string,
    fileBytes: Buffer,
    fileName: string,
  ) => Promise<any>
  public sendAudio!: (
    to: string,
    audioBytes: Buffer,
    fileName: string | null,
    durationMs?: number,
  ) => Promise<any>
  public sendContact!: (
    to: string,
    contactMid: string,
    displayName: string,
  ) => Promise<any>
  public sendSticker!: (
    to: string,
    stickerId: string,
    packageId: string,
    version?: string,
  ) => Promise<any>
  public getRecentMessages!: (chatId: string, count?: number) => Promise<any[]>
  public getPreviousMessages!: (
    chatId: string,
    count?: number,
    before?: { messageId?: string; deliveredTime?: number },
  ) => Promise<any[]>
  public downloadMessageContent!: (
    messageId: string,
    requestId?: string,
  ) => Promise<Buffer>
  public downloadMessageContentPreview!: (
    messageId: string,
    requestId?: string,
  ) => Promise<Buffer>
  public markChatRead!: (
    chatId: string,
    messageId?: string,
  ) => Promise<{
    marked: boolean
    chatId?: string
    lastMessageId?: string
    reason?: string
  }>

  constructor(options: any = {}) {
    super()
    this.options = { autoStart: true, pollInterval: 10000, ...options }
    this.state = STATE.DISCONNECTED
    this.client = null
    this.profile = null
    this.logger = options.logger || createCliLogger('LINE')
    this.startupFlowLogger = null
    this.credentialStore =
      options.credentialStore ||
      new CredentialStore(
        'line',
        this.options.credentialPath ?? 'data/line-credentials.json',
      )
    this.sessionState = new LineSessionState(this.credentialStore)
    this.nameCache = new Map()
    this.chatCache = new Map()
    this.e2eeManager = options.e2eeManager || new E2EEKeyManager()
    this.e2eeWarning = false
    this.loginRequired = false
    this.recentFetchState = new Map()
    this.e2eeManager.setRuntime({
      getClient: () => this.client,
      getStore: () => this.credentialStore,
      getProfileMid: () => this.profile?.mid,
      emitWarning: (payload: {
        active: boolean
        reason: string
        [key: string]: any
      }) => {
        this.e2eeWarning = payload.active
        this.emit('e2eeWarning', payload)
      },
    })

    Object.assign(
      this,
      createAuthSessionService(this, STATE),
      createDirectoryRuntimeService(this),
      createChatRuntimeService(this),
    )
  }

  /**
   * Set the current service state and emit an event.
   * @param newState - The new state to set.
   */
  setState(newState: string): void {
    this.state = newState
    this.emit('state', newState)
  }
}
