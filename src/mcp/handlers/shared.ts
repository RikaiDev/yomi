/**
 * Shared helpers for the Yomi MCP handler modules — the always-fresh
 * session-required error, a plain-text tool error builder, and a JSON
 * result wrapper. Split out of the former handlers.ts so every domain file
 * under src/mcp/handlers/ can import these without a circular dependency.
 */

// Yomi logs in on its own (via the `login`/`login_complete` tools, or
// `npx @rikaidev/yomi login`); it does not depend on inboxd for anything.
export const NO_CREDENTIALS_MESSAGE =
  'No persisted LINE session. Call the `login` tool, or run `npx @rikaidev/yomi login` in a terminal.'

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

/** Wrap a plain result object as a JSON MCP tool result. */
export function jsonResult(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  }
}
