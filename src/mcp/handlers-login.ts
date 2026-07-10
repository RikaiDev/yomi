/**
 * Yomi MCP `login`/`login_complete` handlers.
 *
 * Split out of handlers.ts purely to keep that file (the general tool
 * handler surface) under the project's 500-scc-line module cap; behavior
 * owned here is otherwise unchanged in spirit from what previously lived
 * inline there.
 *
 * Two login paths exist, dispatched by client capability:
 *
 *   - Elicitation clients: the original single-call flow — elicit phone/
 *     region, elicit PIN acknowledgement, block to completion. Unchanged.
 *
 *   - Non-elicitation clients (e.g. Claude Desktop, confirmed empirically —
 *     it does not support MCP elicitation): the PIN has nowhere to go if we
 *     block, since it is produced mid-flow and stderr is invisible to the
 *     human, but a tool RESULT is visible. So the flow is split across two
 *     tool calls: `login` starts the passwordless flow and returns the PIN
 *     as soon as LINE issues it (bounded wait), then `login_complete`
 *     awaits the same in-flight login to finish once the human has acted
 *     on their phone.
 *
 * Both paths call the ONE shared login sequence in ../cli/login.ts
 * (`runPwlessLogin`) — neither duplicates it.
 */

import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { PwlessLoginResult } from '../cli/login.js';
import { runPwlessLogin } from '../cli/login.js';
import { LineProtocolService } from '../line/core/service.js';
import {
  LINE_PIN_CODE_LIFETIME_MS,
  PAAK_AUTH_CLIENT_CEILING_MS,
  PIN_VERIFY_CLIENT_CEILING_MS,
} from '../line/auth/pwless/index.js';
import { createCliLogger } from '../util/log.js';
import { toolError } from './handlers.js';
import { supportsMcpApps } from './ui/capability.js';
import type { LoginStructuredContent } from './ui/login-structured-content.js';

const log = createCliLogger('Yomi');

/** LINE region codes offered on the login elicitation form. */
const LOGIN_REGIONS = ['TW', 'JP', 'TH', 'ID', 'US'];

/**
 * How long a live `pendingLogin` may be reused by a later `login` call for
 * the same phone/region, before treating it as stale and starting fresh.
 *
 * This is bound to LINE's real PIN code lifetime (~line/auth/pwless/index.ts,
 * an external fact from LINE Help Center, ~3 minutes) — NOT to how long
 * yomi's client is willing to keep polling (~16 minutes). A login started
 * 90 seconds ago is still very much alive and its PIN is still valid; the
 * only thing that actually kills a pending login early is LINE's own code
 * expiring, so that is the correct bound for "is this still worth reusing".
 */
const PIN_WINDOW_MS = LINE_PIN_CODE_LIFETIME_MS;

/**
 * How long yomi's client keeps polling for the device-approval step once a
 * PIN has been verified (or skipped via a stored certificate) — the real
 * ceiling `login_complete` blocks for, used only to describe that wait to
 * the human, not to bound anything server-side.
 */
const APPROVAL_WINDOW_MS = PAAK_AUTH_CLIENT_CEILING_MS;

/** How long `login` waits for LINE to issue a PIN before reporting a failure. */
const PIN_WAIT_TIMEOUT_MS = 20000;

/**
 * Elicit `phone`/`region` from the human in one form, pre-filling whatever
 * the caller already supplied.
 *
 * @param server - MCP Server instance (elicitation already capability-gated
 * by the caller).
 * @param phone - Phone already supplied by the tool call, if any.
 * @param region - Region already supplied by the tool call, if any.
 * @returns The collected phone/region, or `null` if the human declined/cancelled.
 */
async function elicitPhoneRegion(
  server: Server,
  phone: string | undefined,
  region: string | undefined,
): Promise<{ phone: string; region: string } | null> {
  const collected = await server.elicitInput({
    message: 'Yomi needs your LINE phone number and region to start passwordless login.',
    requestedSchema: {
      type: 'object',
      properties: {
        phone: {
          type: 'string',
          title: 'Phone number',
          description: 'E.164 form, e.g. +8869XXXXXXXX.',
          ...(phone ? { default: phone } : {}),
        },
        region: {
          type: 'string',
          title: 'Region',
          enum: LOGIN_REGIONS,
          ...(region ? { default: region } : {}),
        },
      },
      required: ['phone', 'region'],
    },
  });
  if (collected.action !== 'accept') {
    return null;
  }
  const collectedPhone = String(collected.content?.phone ?? '');
  const collectedRegion = String(collected.content?.region ?? '');
  if (!collectedPhone || !collectedRegion) {
    return null;
  }
  return { phone: collectedPhone, region: collectedRegion };
}

/**
 * Elicit acknowledgement of the login PIN — fire-and-forget from the
 * caller's perspective (must not block `startPwlessLogin`, which is
 * already running concurrently and waiting on phone biometric approval).
 *
 * @param server - MCP Server instance.
 * @param pin - The PIN LINE just issued.
 * @param onDeclined - Called if the human explicitly declines/cancels the
 * acknowledgement, so a later login failure can be reported as
 * "cancelled by user" instead of a bare protocol error.
 */
function elicitPinAcknowledgement(server: Server, pin: string, onDeclined: () => void): void {
  server.elicitInput({
    message: `LINE PIN: ${pin}\n\nEnter this PIN in the LINE app on your primary phone, then approve `
      + 'the new device from there. Acknowledge below once you have done this.',
    requestedSchema: {
      type: 'object',
      properties: {
        entered: { type: 'boolean', title: 'I entered the PIN and approved the device on my phone' },
      },
    },
  }).then((result) => {
    if (result.action !== 'accept') {
      onDeclined();
    }
  }).catch((error: any) => {
    log.warn('login.pin_ack_failed', { error: error?.message ?? String(error) });
  });
}

/**
 * Handle `login` for a client that supports MCP elicitation — drive the
 * passwordless flow entirely through elicitation, with no out-of-band
 * channel required. Phone/region are elicited when missing, and the PIN is
 * surfaced through a second elicitation fired without blocking
 * `startPwlessLogin`, which keeps running while the human acts on their
 * phone. See ../cli/login.ts for the shared login sequence.
 *
 * @param server - MCP Server instance (for elicitInput).
 * @param service - LineProtocolService (not yet authenticated).
 * @param args - Tool arguments.
 * @returns MCP tool result describing the logged-in profile.
 */
async function handleLoginElicitation(
  server: Server,
  service: LineProtocolService,
  args: { phone?: string; region?: string },
) {
  let { phone, region } = args;
  if (!phone || !region) {
    const collected = await elicitPhoneRegion(server, phone, region);
    if (!collected) {
      return toolError('Login was cancelled by the user.');
    }
    ({ phone, region } = collected);
  }

  let pinDeclined = false;
  const onPin = (pin: string) => {
    log.warn('login.pin', { action: 'elicit_acknowledgement' });
    elicitPinAcknowledgement(server, pin, () => {
      pinDeclined = true;
    });
  };
  const onBiometric = () => {
    log.warn('login.waiting_biometric', { action: 'approve the new device on your phone' });
  };

  try {
    const { mid, displayName } = await runPwlessLogin(service, phone, region, { onPin, onWaitingBiometric: onBiometric });
    log.info('login.complete', { mid });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ loggedIn: true, mid, displayName }, null, 2) }],
    };
  }
  catch (error: any) {
    if (pinDeclined) {
      return toolError('Login was cancelled by the user.');
    }
    return toolError(error?.message ?? String(error));
  }
}

/** At most one in-flight passwordless login at a time, shared across `login`/`login_complete` calls. */
interface PendingLogin {
  /** The runPwlessLogin promise itself — always awaitable, guarded separately against unhandled rejection. */
  promise: Promise<PwlessLoginResult>;
  /** The PIN once LINE has issued it; null while still waiting. */
  pin: string | null;
  /**
   * True once the flow reaches `waitingForBiometric` with `pin` still null —
   * the login had a valid stored certificate, so `requestPinCodeVerif` was
   * skipped entirely and no PIN will ever be issued for this attempt.
   */
  certSkippedPin: boolean;
  phone: string;
  region: string;
  startedAt: number;
  /** Resolves the instant `pin` is set OR `certSkippedPin` becomes true, so a later call can wait on either outcome. */
  pinReady: Promise<void>;
}

let pendingLogin: PendingLogin | null = null;

/**
 * Start a new passwordless login in the background and register it as the
 * one in-flight pending login.
 *
 * The stored promise is the actual `runPwlessLogin` promise, so
 * `login_complete` can await it and see the real success/failure. A
 * `.catch()` is attached immediately (its result discarded, not stored) so
 * an abandoned login — one nobody ever calls `login_complete` for — never
 * surfaces as an unhandled rejection; this does not affect what
 * `pendingLogin.promise` itself resolves/rejects with.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @param phone - Phone number in E.164 form.
 * @param region - Region code.
 * @returns The newly registered pending-login record.
 */
function startPendingLogin(service: LineProtocolService, phone: string, region: string): PendingLogin {
  let resolvePinReady: () => void = () => {};
  const pinReady = new Promise<void>((resolve) => {
    resolvePinReady = resolve;
  });

  const pending: Partial<PendingLogin> = { phone, region, pin: null, certSkippedPin: false, startedAt: Date.now(), pinReady };

  const onPin = (pin: string) => {
    pending.pin = pin;
    resolvePinReady();
  };
  const onBiometric = () => {
    log.warn('login.waiting_biometric', { action: 'approve the new device on your phone' });
    // Reaching biometric wait with no PIN ever set means a valid stored
    // certificate skipped the PIN step entirely (see LinePwlessLogin.login,
    // step 2-3) — resolve `pinReady` now so `waitForPin` doesn't block out
    // its full timeout waiting for a PIN that will never arrive.
    if (!pending.pin) {
      pending.certSkippedPin = true;
      resolvePinReady();
    }
  };

  const promise = runPwlessLogin(service, phone, region, { onPin, onWaitingBiometric: onBiometric });
  promise.catch(() => {
    // Swallow here only to prevent an unhandled-rejection warning for a
    // login nobody completes; the real error still surfaces to whoever
    // awaits `pending.promise` (login_complete) below.
  });

  pending.promise = promise;
  return pending as PendingLogin;
}

/**
 * Wait for a pending login's PIN to arrive, bounded by a timeout.
 *
 * @param pending - The pending login to wait on.
 * @param timeoutMs - Maximum time to wait.
 * @returns The PIN, or `null` if it did not arrive within `timeoutMs`.
 */
async function waitForPin(pending: PendingLogin, timeoutMs: number): Promise<string | null> {
  if (pending.pin) {
    return pending.pin;
  }
  const outcome = await Promise.race([
    pending.pinReady.then(() => pending.pin ?? null),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), timeoutMs); }),
  ]);
  return outcome;
}

/**
 * Handle `login` for a client that does NOT support MCP elicitation
 * (confirmed empirically for Claude Desktop). Splits the flow into two
 * tool calls since the PIN cannot be prompted for in-band: this call
 * starts (or reuses) the passwordless flow and returns the PIN as soon as
 * LINE issues it; `login_complete` finishes it once the human has acted.
 *
 * The MCP Apps view (./ui/login-app.ts) has never been observed to render on
 * any deployed client (see that file's header) — resources/read succeeds
 * but the host never completes `ui/initialize`. The MODEL is therefore
 * always the driver of this flow, regardless of `supportsUi`: the plain
 * `content` text below is fully actionable on its own in every case,
 * identical in substance whether or not the client declares MCP Apps
 * support. The only thing `supportsUi` still changes is:
 *   - missing phone/region: a UI-capable client gets `need_credentials`
 *     structuredContent (so a view CAN render a form if it ever does) plus
 *     text telling the model to ask the human directly and call `login`
 *     again — never text telling it to wait for a form. A non-UI client
 *     gets today's `toolError` naming the missing fields, unchanged.
 *   - `pin`/`cert` stages: the model is ALWAYS told to call `login_complete`
 *     immediately, in both cases. The view (./ui/login-app-view.ts) no
 *     longer calls `login_complete` on its own — display-only now — so
 *     there is exactly one driver and nothing to race.
 *
 * @param service - LineProtocolService (not yet authenticated).
 * @param args - Tool arguments.
 * @param supportsUi - Whether the connected client also negotiated MCP Apps
 * support (../ui/capability.ts's `supportsMcpApps`) — only changes whether
 * `structuredContent`/form-hint text is included, never whether the model is
 * told to act.
 * @returns MCP tool result carrying the PIN and next step, or an honest error.
 */
async function handleLoginNoElicitation(
  service: LineProtocolService,
  args: { phone?: string; region?: string },
  supportsUi: boolean,
) {
  let { phone, region } = args;
  if (!phone) {
    phone = (await service.credentialStore?.get?.('line_phone')) ?? undefined;
  }
  if (!region) {
    region = (await service.credentialStore?.get?.('line_region')) ?? undefined;
  }
  // Build the "which fields are missing" text purely for the message, but
  // return inside a `!phone || !region` guard so TypeScript narrows both to
  // `string` for the rest of the function (no assertion needed).
  if (!phone || !region) {
    if (supportsUi) {
      const needCredentialsContent: LoginStructuredContent = {
        stage: 'need_credentials',
        pin: null,
        regions: LOGIN_REGIONS,
      };
      return {
        content: [{
          type: 'text' as const,
          text: 'Ask the human for their LINE phone number (E.164 form, e.g. +8869XXXXXXXX) and region '
            + `(one of ${LOGIN_REGIONS.join(', ')}), then call \`login\` again with those as arguments. `
            + 'A login form may also appear for the human to fill in directly — if they use it, the '
            + 'login proceeds on its own and there is nothing further for you to do — but do not wait '
            + 'for that; if no form appears, asking the human directly is how this login makes progress.',
        }],
        structuredContent: needCredentialsContent,
      };
    }
    const missing: string[] = [];
    if (!phone) missing.push('phone');
    if (!region) missing.push('region');
    return toolError(
      `Missing ${missing.join(' and ')} for login. This MCP client does not support elicitation, so `
      + `${missing.join('/')} must be supplied as a tool argument, or persisted by running `
      + '`bun run.mjs login` once in a terminal.',
    );
  }

  const now = Date.now();
  const active = pendingLogin && now - pendingLogin.startedAt < PIN_WINDOW_MS ? pendingLogin : null;
  if (active && (active.phone !== phone || active.region !== region)) {
    // A live login for a DIFFERENT number is still in flight. Never hand
    // back its PIN under this call's identity, and never silently start a
    // second flow on top of it. Name nothing sensitive.
    return toolError(
      'A login for a different phone number is still in progress. Call `login_complete` to finish it, '
      + 'or wait for its login code to expire (LINE gives the human about 3 minutes to act on it), '
      + 'before starting a login for another number.',
    );
  }
  // Reuse the in-flight login only when it matches this number; otherwise
  // start a fresh one. `pending` is non-null either way, so no narrowing of
  // the module-level `pendingLogin` is needed downstream.
  const pending = active ?? startPendingLogin(service, phone, region);
  pendingLogin = pending;

  const pin = await waitForPin(pending, PIN_WAIT_TIMEOUT_MS);
  if (!pin) {
    if (pending.certSkippedPin) {
      // A valid stored login certificate skipped the PIN step entirely — the
      // flow is already past it and waiting on phone approval of this device.
      // Call `login_complete` right now; there is no PIN to wait for.
      log.warn('login.pin', { action: 'skipped_cert_valid' });
      const certStructuredContent: LoginStructuredContent = {
        stage: 'cert',
        pin: null,
        clientApprovalPollCeilingSeconds: Math.round(APPROVAL_WINDOW_MS / 1000),
      };
      const certSteps = 'No PIN needed — LINE recognized a stored login certificate from a previous login, '
        + 'so the PIN step was skipped.\n\n'
        + '0. This only works if the primary phone has 設定 > 我的帳號 > 允許自其他裝置登入 '
        + 'enabled — without it LINE will not offer this device a sign-in prompt at all.\n'
        + '1. Bring the LINE app to the foreground on your primary phone — it should prompt you '
        + 'to approve this new device signing in.\n'
        + '2. Approve the device from there.\n\n';
      const certText = certSteps
        + 'Call the `login_complete` tool (no arguments) IMMEDIATELY now — do not wait for '
        + 'confirmation that the approval happened first. `login_complete` blocks by itself while '
        + `you approve (up to about ${Math.round(APPROVAL_WINDOW_MS / 60000)} minutes) and returns `
        + 'your profile once it succeeds.';
      return {
        content: [{ type: 'text' as const, text: certText }],
        structuredContent: certStructuredContent,
      };
    }
    return toolError(
      'LINE has not issued a login PIN within 20s. The attempt is still running in the background '
      + '(do not worry, nothing was lost) — call `login` again shortly to check for the PIN.',
    );
  }

  log.warn('login.pin', { action: 'returned_in_tool_result' });
  const pinCodeLifetimeSeconds = Math.round(LINE_PIN_CODE_LIFETIME_MS / 1000);
  const clientPinPollCeilingMinutes = Math.round(PIN_VERIFY_CLIENT_CEILING_MS / 60000);
  const clientApprovalPollCeilingMinutes = Math.round(APPROVAL_WINDOW_MS / 60000);
  const pinStructuredContent: LoginStructuredContent = {
    stage: 'pin',
    pin,
    pinCodeLifetimeSeconds,
    clientPinPollCeilingSeconds: Math.round(PIN_VERIFY_CLIENT_CEILING_MS / 1000),
    clientApprovalPollCeilingSeconds: Math.round(APPROVAL_WINDOW_MS / 1000),
  };
  const pinSteps = 'LINE PIN:\n\n'
    + `    ${pin}\n\n`
    + '0. This only works if the primary phone has 設定 > 我的帳號 > 允許自其他裝置登入 enabled — '
    + 'without it LINE will not offer this device a sign-in prompt at all.\n'
    + '1. Open LINE on the primary phone. If a verification prompt does not appear immediately, '
    + 'bringing the app to the foreground surfaces it.\n'
    + `2. Enter this PIN and tick the device that is signing in, then tap 「用戶確認」 — LINE gives `
    + `you ${pinCodeLifetimeSeconds} seconds (about 3 minutes) from when the code was shown to do this.\n`
    + '3. LINE will then ask that same phone to approve this new device signing in — approve it there.\n\n';
  const pinText = pinSteps
    + `Call the \`login_complete\` tool (no arguments) IMMEDIATELY now — do not wait until you have `
    + 'entered the PIN or approved the device. `login_complete` blocks by itself through both of '
    + `those steps: it keeps waiting up to about ${clientPinPollCeilingMinutes} minutes for step 2 and `
    + `up to about ${clientApprovalPollCeilingMinutes} more minutes for step 3, well beyond LINE's own `
    + `${pinCodeLifetimeSeconds}-second code deadline, so a slow phone is never the failure — missing `
    + 'that 3-minute deadline is what actually kills the code.\n\n'
    + '(This PIN step is skipped on future logins once a login certificate has been stored.)';
  return {
    content: [{ type: 'text' as const, text: pinText }],
    structuredContent: pinStructuredContent,
  };
}

/**
 * Handle `login` — dispatches to the elicitation flow when the connected
 * client supports it, otherwise the two-phase flow that finishes via
 * `login_complete`.
 *
 * @param server - MCP Server instance (for elicitInput/getClientCapabilities).
 * @param service - LineProtocolService (not yet authenticated).
 * @param args - Tool arguments.
 * @returns MCP tool result.
 */
export async function handleLogin(
  server: Server,
  service: LineProtocolService,
  args: { phone?: string; region?: string },
) {
  if (server.getClientCapabilities()?.elicitation) {
    return handleLoginElicitation(server, service, args);
  }
  return handleLoginNoElicitation(service, args, supportsMcpApps(server.getClientCapabilities()));
}

/**
 * Handle `login_complete` — finish a login started by a prior `login` call
 * on a non-elicitation client. Awaits the same in-flight `runPwlessLogin`
 * promise `login` started, so the real success/failure surfaces here.
 * Never touches credentials on the failure path.
 *
 * @returns MCP tool result describing the logged-in profile, or an honest error.
 */
export async function handleLoginComplete() {
  if (!pendingLogin) {
    return toolError(
      'No login is pending. Call `login` first to start a passwordless login. '
      + '(If you already called `login`, a previous attempt may have finished or its PIN code may have '
      + `expired — LINE only gives the human about ${Math.round(LINE_PIN_CODE_LIFETIME_MS / 1000)} seconds `
      + '(about 3 minutes) to act on a shown code. Calling `login` again is safe.)',
    );
  }
  const pending = pendingLogin;
  try {
    const { mid, displayName } = await pending.promise;
    pendingLogin = null;
    log.info('login.complete', { mid });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ loggedIn: true, mid, displayName }, null, 2) }],
    };
  }
  catch (error: any) {
    pendingLogin = null;
    return toolError(error?.message ?? String(error));
  }
}
