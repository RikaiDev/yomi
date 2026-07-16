import { expect, mock, test } from 'bun:test'
import {
  sessionExpiredError,
  sessionRevokedError,
} from '../../mcp/handlers/shared.js'
import { resumeSession } from './auth-session-runtime.js'

/**
 * Silence the runtime's startup/flow logging for the duration of a test.
 */
const silentLog = {
  info() {},
  warn() {},
  error() {},
  debug() {},
}

/**
 * Build the minimum LineProtocolService surface resumeSession touches.
 *
 * Only the collaborators on the restore path are stubbed: a saved auth token
 * (so restore is attempted rather than skipped), an empty credential store (so
 * E2EE restore short-circuits), and state/event sinks.
 */
function makeService() {
  return {
    loginRequired: false,
    loginReason: null as string | null,
    client: null as any,
    profile: null,
    logger: silentLog,
    startupFlowLogger: silentLog,
    state: 'connected',
    recentFetchState: new Map(),
    setState(next: string) {
      this.state = next
    },
    emit() {},
    on() {},
    e2eeManager: { setRuntime() {}, importKeys() {}, bindSelfKeysToMid() {} },
    credentialStore: {
      async get() {
        return null
      },
      async set() {},
    },
    sessionState: {
      authToken: 'stale-token',
      async loadFromStore() {},
      async loadRecentFetchState() {
        return new Map()
      },
      bindClient() {},
    },
  }
}

/**
 * Drive a full resumeSession against a client whose getProfile() rejects.
 *
 * resumeSession dynamically imports LineClient, so the module is mocked to keep
 * the restore path off the network; validation then fails with `profileError`,
 * which is what classifies loginReason.
 *
 * @param profileError - Error the stubbed getProfile() throws.
 * @returns The service, post-restore, for assertion.
 */
async function resumeWithProfileError(profileError: Error) {
  mock.module('../client/index.js', () => ({
    LineClient: class {
      on() {}
      async getProfile() {
        throw profileError
      }
    },
  }))
  const service = makeService()
  await resumeSession(service)
  return service
}

test('a LINE-rejected token classifies loginReason as revoked', async () => {
  const service = await resumeWithProfileError(
    new Error('V3_TOKEN_CLIENT_LOGGED_OUT'),
  )
  expect(service.loginRequired).toBe(true)
  expect(service.loginReason).toBe('revoked')
})

test('an aged-out token whose refresh fails classifies loginReason as expired', async () => {
  const service = await resumeWithProfileError(
    new Error('access token expired'),
  )
  expect(service.loginRequired).toBe(true)
  expect(service.loginReason).toBe('expired')
})

test('the two causes tell the user different stories, with the same recovery', () => {
  const revoked = sessionRevokedError().content[0].text
  const expired = sessionExpiredError().content[0].text

  expect(revoked).not.toBe(expired)
  // Only a revocation may blame another device — claiming one for a token that
  // merely aged out sends the user hunting for a login that never happened.
  expect(revoked).toContain('somewhere else')
  expect(expired).not.toContain('somewhere else')
  expect(expired).toContain('expired')
  // Both still point at the same way out.
  expect(revoked).toContain('`login`')
  expect(expired).toContain('`login`')
})
