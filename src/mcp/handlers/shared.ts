import { encode } from '@toon-format/toon'

/**
 * Shared helpers for the Yomi MCP handler modules — the always-fresh
 * session-required error, a plain-text tool error builder, and compact JSON /
 * TOON result wrappers. Split out of the former handlers.ts so every domain file
 * under src/mcp/handlers/ can import these without a circular dependency.
 */

// Yomi logs in on its own (via the `login`/`login_complete` tools, or
// `npx @rikaidev/yomi login`); it does not depend on inboxd for anything.
export const NO_CREDENTIALS_MESSAGE =
  'No persisted LINE session. Call the `login` tool, or run `npx @rikaidev/yomi login` in a terminal.'

// Shown when LINE invalidated a previously working session — distinct from
// "never logged in" so the model tells the user the right story: the MCP
// connection is healthy, LINE revoked this device's token (usually because
// the same account logged in somewhere else).
const SESSION_REVOKED_MESSAGE =
  'LINE signed this device out — usually because the same account logged in ' +
  'somewhere else (another device, or a terminal `login` run). The MCP ' +
  'connection itself is fine. Call the `login` tool to reconnect; cached ' +
  'credentials usually complete without a new PIN.'

/**
 * Build the always-fresh session-required error payload.
 *
 * @returns MCP tool error content.
 */
export function sessionRequiredError() {
  return {
    content: [{ type: 'text' as const, text: NO_CREDENTIALS_MESSAGE }],
    isError: true,
  }
}

// Shown when the saved token simply aged out and the silent refresh failed.
// Recovery is the same `login` call as a revocation, but the cause is not — no
// competing login happened, so claiming one sends the user hunting for a device
// that never signed in.
const SESSION_EXPIRED_MESSAGE =
  'The saved LINE session expired and the automatic token refresh failed. ' +
  'Nothing signed this device out — the token simply aged out, and the MCP ' +
  'connection itself is fine. Call the `login` tool to reconnect; cached ' +
  'credentials usually complete without a new PIN.'

/**
 * Build the session-revoked error payload (LINE logged this device out).
 *
 * @param detail - Optional raw LINE error message, appended as diagnostics.
 * @returns MCP tool error content.
 */
export function sessionRevokedError(detail?: string) {
  const text = detail
    ? `${SESSION_REVOKED_MESSAGE}\n\n(diagnostic: ${detail})`
    : SESSION_REVOKED_MESSAGE
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  }
}

/**
 * Build the session-expired error payload (token aged out, refresh failed).
 *
 * @param detail - Optional raw LINE error message, appended as diagnostics.
 * @returns MCP tool error content.
 */
export function sessionExpiredError(detail?: string) {
  const text = detail
    ? `${SESSION_EXPIRED_MESSAGE}\n\n(diagnostic: ${detail})`
    : SESSION_EXPIRED_MESSAGE
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  }
}

/**
 * Build a plain-text MCP tool error payload.
 *
 * @param message - Human-readable error message.
 * @returns MCP tool error content.
 */
export function toolError(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  }
}

/** Encode a small machine-friendly payload without pretty-print whitespace. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value)
}

/** Encode a large, repetitive read payload for token-efficient model consumption. */
export function toonText(value: unknown): string {
  return encode(value)
}

/** Wrap a small plain result object as a compact JSON MCP tool result. */
export function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: jsonText(value) }],
  }
}

/** Wrap a large read result as a token-efficient TOON MCP tool result. */
export function toonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: toonText(value) }],
  }
}
