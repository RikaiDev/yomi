/**
 * Shape of the `structuredContent` the `login` tool's non-elicitation path
 * attaches to its result, consumed by the login MCP-Apps UI
 * (./login-app.ts) via the `ui/notifications/tool-result` postMessage
 * notification. Kept in its own module so both the handler
 * (../handlers-login.ts) and any future reader agree on one shape instead
 * of each inlining an ad hoc object literal.
 *
 * Two clocks, never conflated (see ../../line/auth/pwless/index.ts):
 *   - `pinCodeLifetimeSeconds` is LINE's own server-side deadline (~3 min,
 *     an external fact) — the one the human can actually miss.
 *   - `clientPinPollCeilingSeconds` / `clientApprovalPollCeilingSeconds` are
 *     how long yomi's client keeps polling (~16 min / ~13 min) — always
 *     longer, so a slow phone is never the failure mode.
 */
export interface LoginStructuredContentPin {
  /** `pin` — LINE issued a PIN the human must enter. */
  stage: 'pin';
  /** The PIN to enter. */
  pin: string;
  /** LINE's real server-side deadline to enter the PIN and confirm the device (external fact, ~3 min). */
  pinCodeLifetimeSeconds: number;
  /** How long yomi's client keeps polling for the PIN-verification step before giving up (~16 min). */
  clientPinPollCeilingSeconds: number;
  /** How long yomi's client keeps polling for the device-approval step that follows (~13 min). */
  clientApprovalPollCeilingSeconds: number;
}

export interface LoginStructuredContentCert {
  /** `cert` — a stored login certificate skipped the PIN step entirely; only the device-approval step remains. */
  stage: 'cert';
  /** No PIN was issued in this stage. */
  pin: null;
  /** How long yomi's client keeps polling for the device-approval step (~13 min). */
  clientApprovalPollCeilingSeconds: number;
}

/**
 * `need_credentials` — phone/region were missing and this client supports
 * MCP Apps, so a login form was shown to the human instead of failing with
 * a tool error. `regions` is the SAME `LOGIN_REGIONS` array the elicitation
 * path offers (../handlers-login.ts) — carried here because the view
 * (./login-app-view.ts) is a static HTML/JS string with no import of its
 * own; this is how it avoids retyping the list.
 */
export interface LoginStructuredContentNeedCredentials {
  stage: 'need_credentials';
  /** No PIN has been issued yet — the flow has not even started. */
  pin: null;
  /** Region codes offered on the form's region `<select>`, sourced from `LOGIN_REGIONS`. */
  regions: string[];
}

export type LoginStructuredContent =
  | LoginStructuredContentPin
  | LoginStructuredContentCert
  | LoginStructuredContentNeedCredentials;
